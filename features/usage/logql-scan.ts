import * as React from "react"
import { create } from "zustand"

import { grafanaConnection, grafanaKey, grafanaSettings } from "@/features/usage/grafana-store"
import { useAppStore } from "@/lib/store/app-store"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { hostOf } from "@/lib/core/grafana-usage"
import { logQueriesOfDashboard, type LogQueryRef, type LogUsageEvidence } from "@/lib/core/logs/logql-usage"
import { fetchDashboard, listDashboards } from "@/lib/sources/grafana"

// The LogQL scan of the configured Grafana: every dashboard's Loki panel
// queries and query variables, kept per Grafana URL in IndexedDB. The Grafana
// usage scan in Settings indexes PromQL only; this is its logs twin.

const isAbort = (error: unknown) => error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface LogqlUsageIndex {
  version: 1
  baseUrl: string
  scannedAt: string
  dashboardsScanned: number
  /** Dashboards that couldn't be read. */
  failed: number
  queries: LogQueryRef[]
}

const DB_NAME = "cardinal-logql-usage"
const STORE = "indexes"
let opening: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

async function idb<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

interface LogqlScanState {
  index: LogqlUsageIndex | null
  /** The Grafana URL `index` was loaded for ("" before loading). */
  loadedFor: string | null
  progress: { done: number; total: number } | null
  error: string | null
}

const useLogqlScanStore = create<LogqlScanState>()(() => ({ index: null, loadedFor: null, progress: null, error: null }))

async function loadFor(key: string) {
  if (useLogqlScanStore.getState().loadedFor === key) return
  useLogqlScanStore.setState({ loadedFor: key, index: null })
  const index = key ? await idb("readonly", (store) => store.get(key) as IDBRequest<LogqlUsageIndex | undefined>) : null
  if (useLogqlScanStore.getState().loadedFor === key) useLogqlScanStore.setState({ index: index && index.version === 1 ? index : null })
}

let controller: AbortController | null = null

/** Reads every dashboard of the configured Grafana, four at a time, and keeps its LogQL queries. */
export async function startLogqlScan() {
  const connection = grafanaConnection(grafanaSettings())
  if (!connection) throw new Error("Connect Grafana in Settings first.")
  controller?.abort()
  const own = new AbortController()
  controller = own
  useLogqlScanStore.setState({ progress: { done: 0, total: 0 }, error: null })
  try {
    const hits = await listDashboards(connection, own.signal)
    const queries: LogQueryRef[] = []
    let done = 0
    let failed = 0
    useLogqlScanStore.setState({ progress: { done, total: hits.length } })
    await runWithConcurrency(
      hits,
      async (hit) => {
        try {
          const { dashboard, meta } = await fetchDashboard(connection, hit.uid, own.signal)
          const title = (dashboard as { title?: string } | null)?.title ?? hit.title ?? hit.uid
          queries.push(...logQueriesOfDashboard(dashboard, { title, url: meta?.url ?? hit.url ?? `/d/${hit.uid}` }))
        } catch (error) {
          if (isAbort(error) || own.signal.aborted) throw error
          failed += 1
        }
        done += 1
        if (controller === own) useLogqlScanStore.setState({ progress: { done, total: hits.length } })
      },
      4,
      own.signal
    )
    const index: LogqlUsageIndex = { version: 1, baseUrl: grafanaKey(connection.baseUrl), scannedAt: new Date().toISOString(), dashboardsScanned: hits.length, failed, queries }
    await idb("readwrite", (store) => store.put(index, index.baseUrl))
    if (useLogqlScanStore.getState().loadedFor === index.baseUrl) useLogqlScanStore.setState({ index })
    return index
  } catch (error) {
    if (controller === own && !own.signal.aborted) useLogqlScanStore.setState({ error: message(error) })
    throw error
  } finally {
    if (controller === own) {
      controller = null
      useLogqlScanStore.setState({ progress: null })
    }
  }
}

/** The stored scan of the configured Grafana, outside React (the agent's tools); null when there is none. */
export async function readLogqlIndex(): Promise<LogqlUsageIndex | null> {
  const key = grafanaKey(grafanaSettings().baseUrl)
  if (!key) return null
  const index = await idb("readonly", (store) => store.get(key) as IDBRequest<LogqlUsageIndex | undefined>)
  return index && index.version === 1 ? index : null
}

export function cancelLogqlScan() {
  controller?.abort(new DOMException("Scan cancelled", "AbortError"))
}

/** The LogQL scan of the configured Grafana (null when there is none), and the scan's state. */
export function useLogqlUsage() {
  const baseUrl = useAppStore((state) => grafanaKey(state.grafanaSettings.baseUrl))
  const state = useLogqlScanStore()
  React.useEffect(() => {
    void loadFor(baseUrl)
  }, [baseUrl])
  const index = state.loadedFor === baseUrl && state.index?.baseUrl === baseUrl ? state.index : null
  return {
    index,
    grafanaConfigured: Boolean(baseUrl),
    grafanaHost: baseUrl ? hostOf(baseUrl) : null,
    loading: state.loadedFor !== baseUrl,
    progress: state.progress,
    error: state.error,
  }
}

/** The scan as usage evidence, or null when there is none. */
export function logqlScanEvidence(index: LogqlUsageIndex | null): LogUsageEvidence["dashboards"] {
  return index ? { queries: index.queries, host: hostOf(index.baseUrl), scannedAt: index.scannedAt, dashboardsScanned: index.dashboardsScanned } : null
}
