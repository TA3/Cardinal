import { create } from "zustand"

import { clearCachedIndexes, loadCachedIndex, saveCachedIndex } from "@/features/usage/index-cache"
import type { GrafanaUsageIndex } from "@/lib/core/grafana-usage"
import { buildUsageIndexFromFiles, UPLOADED_USAGE_KEY } from "@/lib/core/usage-files"
import { scanGrafana, type GrafanaConnection, type GrafanaScanProgress } from "@/lib/sources/grafana"
import { DEFAULT_GRAFANA_SETTINGS, useAppStore, type GrafanaSettings } from "@/lib/store/app-store"

// The dashboard usage scan of the Grafana connection (Settings → Grafana; the
// URL and token live in the app store's grafanaSettings), or the same index
// built from uploaded exports. It lives in IndexedDB per Grafana URL (uploads
// without a URL under UPLOADED_USAGE_KEY); this store holds the current one.

export type { GrafanaSettings }

export type IndexStatus = "none" | "loading" | "ready"

interface GrafanaState {
  /** The last scan of the configured URL, null when there is none. */
  index: GrafanaUsageIndex | null
  /** "loading" while the cached scan is read from IndexedDB. */
  indexStatus: IndexStatus
  /** The scan running now. */
  progress: GrafanaScanProgress | null
  scanError: string | null
}

/** The key a scan is cached under: the URL without trailing slashes. */
export function grafanaKey(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "")
}

export function grafanaConnection(settings: Pick<GrafanaSettings, "baseUrl" | "token" | "mode">): GrafanaConnection | null {
  const baseUrl = grafanaKey(settings.baseUrl)
  return baseUrl ? { baseUrl, token: settings.token, mode: settings.mode } : null
}

/** The Grafana connection's settings, outside React. */
export function grafanaSettings() {
  return useAppStore.getState().grafanaSettings
}

/** Where the current usage index is cached: the Grafana URL, or the uploads' key without one. */
function usageKey() {
  return grafanaKey(grafanaSettings().baseUrl) || UPLOADED_USAGE_KEY
}

export const useGrafanaStore = create<GrafanaState>()(() => ({ index: null, indexStatus: "none", progress: null, scanError: null }))

let loadTimer: ReturnType<typeof setTimeout> | undefined

/** Loads the cached scan for the configured URL (debounced while typing). */
function scheduleIndexLoad(delay = 300) {
  clearTimeout(loadTimer)
  const key = usageKey()
  if (useGrafanaStore.getState().index?.baseUrl !== key) useGrafanaStore.setState({ index: null, indexStatus: "loading" })
  loadTimer = setTimeout(() => void loadIndexFor(key), delay)
}

async function loadIndexFor(key: string) {
  const index = await loadCachedIndex(key)
  // The URL changed while this loaded.
  if (usageKey() !== key) return
  useGrafanaStore.setState({ index, indexStatus: index ? "ready" : "none" })
}

/** The cached scan for the configured URL, loading it first if needed (for the agent). */
export async function ensureGrafanaIndex(): Promise<GrafanaUsageIndex | null> {
  const { index } = useGrafanaStore.getState()
  const key = usageKey()
  if (index?.baseUrl === key) return index
  await loadIndexFor(key)
  return useGrafanaStore.getState().index
}

let scanController: AbortController | null = null

/** Scans the configured Grafana; the result replaces the cached scan. Runs on when the page changes. */
export async function startGrafanaScan(): Promise<GrafanaUsageIndex> {
  const connection = grafanaConnection(grafanaSettings())
  if (!connection) throw new Error("Enter the Grafana URL first.")
  scanController?.abort()
  const controller = new AbortController()
  scanController = controller
  useGrafanaStore.setState({ progress: { phase: "Listing dashboards", done: 0, total: 0 }, scanError: null })
  try {
    const index = await scanGrafana(connection, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (scanController === controller) useGrafanaStore.setState({ progress })
      },
    })
    await saveCachedIndex(index)
    if (grafanaKey(grafanaSettings().baseUrl) === index.baseUrl) useGrafanaStore.setState({ index, indexStatus: "ready" })
    return index
  } catch (error) {
    if (scanController === controller && !controller.signal.aborted) {
      useGrafanaStore.setState({ scanError: error instanceof Error ? error.message : String(error) })
    }
    throw error
  } finally {
    if (scanController === controller) {
      scanController = null
      useGrafanaStore.setState({ progress: null })
    }
  }
}

/**
 * Builds the usage index from exported dashboards and rule files instead of a
 * scan, with no Grafana credentials. It replaces the current index.
 */
export async function importUsageFiles(files: File[]): Promise<GrafanaUsageIndex> {
  const texts = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })))
  const index = buildUsageIndexFromFiles(texts, grafanaKey(grafanaSettings().baseUrl))
  // Nothing usable: keep the current index rather than replace it with an empty one.
  if (!index.stats.dashboards && !index.stats.queries) {
    const first = index.problems[0]
    throw new Error(first ? `${first.where}: ${first.message}` : "No dashboards or rules found in those files.")
  }
  await saveCachedIndex(index)
  if (usageKey() === index.baseUrl) useGrafanaStore.setState({ index, indexStatus: "ready", scanError: null })
  return index
}

export function cancelGrafanaScan() {
  scanController?.abort(new DOMException("Scan cancelled", "AbortError"))
}

if (typeof window !== "undefined") {
  scheduleIndexLoad(0)
  useAppStore.subscribe((state, previous) => {
    // "Clear local data" puts the Grafana settings back to the defaults: drop the scans too.
    if (state.grafanaSettings === DEFAULT_GRAFANA_SETTINGS && previous.grafanaSettings !== DEFAULT_GRAFANA_SETTINGS) {
      cancelGrafanaScan()
      useGrafanaStore.setState({ index: null, indexStatus: "none", scanError: null })
      void clearCachedIndexes()
      return
    }
    if (grafanaKey(state.grafanaSettings.baseUrl) !== grafanaKey(previous.grafanaSettings.baseUrl)) scheduleIndexLoad()
  })
}
