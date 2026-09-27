import * as React from "react"
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { computeExpectedSavings } from "@/lib/cardinality/dashboard-helpers"
import { fetchRecommendations, isGrafanaCloud } from "@/lib/sources/adaptive-metrics"
import {
  fetchJobDrilldown,
  fetchMetricDrilldown,
  fetchRuleUsage,
  fetchSeriesByJob,
  fetchSnapshot,
  fetchSeriesHistory,
  fetchTopLabelValues,
  fetchTsdbStatus,
  type HistoryRange,
} from "@/lib/sources/prometheus"
import type { MetricDrilldown } from "@/lib/prometheus/types"
import { HttpError, type Connection } from "@/lib/sources/transport"
import { currentConnection, needsLogsToken, needsToken, useAppStore } from "@/lib/store/app-store"
import { computeLogSavings } from "@/lib/core/logs/impact"
import { logRuleCounts } from "@/lib/core/logs/snapshot"
import type { LogsRange } from "@/lib/core/logs/types"
import type { Signal } from "@/lib/core/signals"
import { fetchLogsSnapshot, fetchLogsVolumeHistory } from "@/lib/sources/loki"

// Server data for the UI. Queries are keyed by the connection (never the token)
// so switching backends never shows another backend's cached data.

/** A signal's connection; metrics by default. */
export function useConnection(signal: Signal = "metrics"): Connection | null {
  const settings = useAppStore((state) => (signal === "logs" ? state.logsSettings : state.settings))
  return React.useMemo(() => currentConnection(settings), [settings])
}

export function connectionKey(connection: Connection | null) {
  return connection ? `${connection.mode}:${connection.baseUrl}:${connection.instanceId ?? ""}:${connection.tenant ?? ""}` : "none"
}

/** 401 only: a 403 usually means a token without the scope for one endpoint, not a missing token. */
export function isAuthError(error: unknown) {
  return error instanceof HttpError && error.status === 401
}

/**
 * One wording for failed requests on every page: a 401 says which backend
 * refused and where to fix it; anything else is the error's own message.
 */
export function authErrorText(error: unknown, signal: Signal = "metrics") {
  if (isAuthError(error)) return `Unauthorized: ${signal === "logs" ? "Loki" : "Prometheus"} rejected the request (HTTP 401). Enter your token in Settings.`
  return error instanceof Error ? error.message : String(error)
}

/** Caches a breakdown unless the connection changed while it loaded. */
export function cacheDrilldownFor(connection: Connection | null, drilldown: MetricDrilldown) {
  if (connectionKey(connection) !== connectionKey(currentConnection())) return
  useAppStore.getState().cacheDrilldown(drilldown)
}

export function useNeedsToken() {
  return useAppStore((state) => needsToken(state))
}

export function useIsGrafanaCloud() {
  const connection = useConnection()
  return connection ? isGrafanaCloud(connection) : false
}

const REFRESH_KEY = ["refresh-snapshot"]

/**
 * Re-runs the snapshot. Every caller shares one mutation key, so the shortcut and
 * the button show the same spinner and never run two refreshes at once.
 */
export function useRefreshSnapshot() {
  const queryClient = useQueryClient()
  const running = useIsMutating({ mutationKey: REFRESH_KEY }) > 0
  const mutation = useMutation({
    mutationKey: REFRESH_KEY,
    // Reads settings at call time so a refresh right after a settings change uses them.
    mutationFn: async () => {
      const { settings, log } = useAppStore.getState()
      const connection = currentConnection(settings)
      if (!connection) throw new Error("Connect a data source first")
      const key = connectionKey(connection)
      log(`Starting snapshot against ${connection.baseUrl}`)
      const { setSnapshotProgress } = useAppStore.getState()
      try {
        return { key, snapshot: await fetchSnapshot(connection, settings.topN, { onProgress: log, onStep: setSnapshotProgress }) }
      } finally {
        setSnapshotProgress(null)
      }
    },
    onSuccess: ({ key, snapshot }) => {
      const { setSnapshot, log } = useAppStore.getState()
      // The connection changed mid-flight: this snapshot belongs to the old backend.
      if (key !== connectionKey(currentConnection())) {
        log("Discarded a snapshot from a previous connection")
        return
      }
      setSnapshot(snapshot)
      log(`Snapshot: ${snapshot.totalSeries.toLocaleString()} series across ${snapshot.metricCount.toLocaleString()} metrics`)
    },
    onError: (error) => useAppStore.getState().log(`Snapshot failed: ${error.message}`),
  })
  const { mutate } = mutation
  const refresh = React.useCallback(() => {
    if (queryClient.isMutating({ mutationKey: REFRESH_KEY }) > 0) return
    mutate()
  }, [queryClient, mutate])
  return { refresh, isPending: running }
}

export function useJobDrilldown(job: string | undefined) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["job", connectionKey(connection), job],
    // "" is a real job: series without a job label.
    enabled: Boolean(connection) && job !== undefined,
    queryFn: ({ signal }) => fetchJobDrilldown(connection!, job!, { signal }),
  })
}

export function useMetricDrilldown(metric: string | undefined, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["metric", connectionKey(connection), metric, job ?? null],
    enabled: Boolean(connection && metric),
    queryFn: async ({ signal }) => {
      const drilldown = await fetchMetricDrilldown(connection!, metric!, { job, signal })
      // Unscoped breakdowns feed savings estimates and the agent.
      if (job === undefined) cacheDrilldownFor(connection, drilldown)
      return drilldown
    },
  })
}

export function useSeriesByJob(metric: string | undefined) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["series-by-job", connectionKey(connection), metric],
    enabled: Boolean(connection && metric),
    queryFn: ({ signal }) => fetchSeriesByJob(connection!, metric!, signal),
  })
}

export function useLabelValues(metric: string, label: string, enabled: boolean, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["label-values", connectionKey(connection), metric, label, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: ({ signal }) => fetchTopLabelValues(connection!, metric, label, { job, limit: 25, signal }),
  })
}

export function useRuleUsage(metric: string | undefined) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["rule-usage", connectionKey(connection), metric],
    enabled: Boolean(connection && metric),
    queryFn: async ({ signal }) => (await fetchRuleUsage(connection!, [metric!], signal))[metric!] ?? [],
    retry: false,
  })
}

export function useAdaptiveRecommendations() {
  const connection = useConnection()
  const cloud = connection ? isGrafanaCloud(connection) : false
  return useQuery({
    queryKey: ["adaptive-recommendations", connectionKey(connection)],
    enabled: cloud,
    queryFn: ({ signal }) => fetchRecommendations(connection!, { signal }),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

export function useSavings() {
  const rules = useAppStore((state) => state.rules)
  const snapshot = useAppStore((state) => state.snapshot)
  const drilldowns = useAppStore((state) => state.drilldowns)
  return React.useMemo(() => computeExpectedSavings(rules, snapshot, drilldowns), [rules, snapshot, drilldowns])
}

export function useRuleCounts() {
  const rules = useAppStore((state) => state.rules)
  return React.useMemo(
    () => ({
      active: rules.filter((rule) => rule.status === "active").length,
      proposed: rules.filter((rule) => rule.status === "proposed").length,
    }),
    [rules]
  )
}

export function useSeriesHistory(range: HistoryRange) {
  const connection = useConnection()
  const total = useAppStore((state) => state.snapshot?.totalSeries)
  return useQuery({
    queryKey: ["series-history", connectionKey(connection), range],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchSeriesHistory(connection!, range, total, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

export function useTsdbStatus() {
  const connection = useConnection()
  return useQuery({
    queryKey: ["tsdb-status", connectionKey(connection)],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchTsdbStatus(connection!, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

function formatAge(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

/**
 * Provenance of the loaded snapshot: when it was captured, from which host,
 * and a label such as "12 min ago" that refreshes every 30 s. `stale` is true
 * after a day. Null when there is no snapshot. `host` is null on snapshots
 * saved before hosts were recorded.
 */
export function useSnapshotAge() {
  const capturedAt = useAppStore((state) => state.snapshot?.capturedAt)
  const host = useAppStore((state) => state.snapshot?.host)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!capturedAt) return
    // A snapshot newer than `now` reads as "just now" until the next tick.
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [capturedAt])
  return React.useMemo(() => {
    if (!capturedAt) return null
    const at = new Date(capturedAt)
    const ageMs = Math.max(0, now - at.getTime())
    return { capturedAt: at, host: host ?? null, ageMs, label: formatAge(ageMs), stale: ageMs > 24 * 3_600_000 }
  }, [capturedAt, host, now])
}

/** The running snapshot's progress ({done, total, phase}), or null when none is running. */
export function useSnapshotProgress() {
  return useAppStore((state) => state.snapshotProgress)
}

// ---------------------------------------------------------------------------
// Logs (Loki). Queries carry meta.signal = "logs" so a 401 marks the logs
// connection, not the metrics one (see src/main.tsx).
// ---------------------------------------------------------------------------

export const LOGS_META = { signal: "logs" } as const

const LOGS_REFRESH_KEY = ["refresh-logs-snapshot"]

/** The mutation key every refresh of a signal's snapshot shares. */
export function refreshSnapshotKey(signal: Signal) {
  return signal === "logs" ? LOGS_REFRESH_KEY : REFRESH_KEY
}

export function useLogsConnection() {
  return useConnection("logs")
}

export function useNeedsLogsToken() {
  return useAppStore((state) => needsLogsToken(state))
}

/** A signal's connection needs a token this tab doesn't have. */
export function useNeedsTokenFor(signal: Signal) {
  return useAppStore((state) => (signal === "logs" ? needsLogsToken(state) : needsToken(state)))
}

export interface LogsRefreshOptions {
  /** Saved as the logs range before the snapshot runs. */
  range?: LogsRange
  /** Saved as the group label ("" = auto) before the snapshot runs. */
  groupLabel?: string
}

/**
 * Re-runs the logs snapshot. Like useRefreshSnapshot, every caller shares one
 * mutation key, so only one logs refresh runs at a time.
 */
export function useRefreshLogsSnapshot() {
  const queryClient = useQueryClient()
  const running = useIsMutating({ mutationKey: LOGS_REFRESH_KEY }) > 0
  const mutation = useMutation({
    mutationKey: LOGS_REFRESH_KEY,
    meta: LOGS_META,
    mutationFn: async (options: LogsRefreshOptions | void) => {
      const { updateLogsSettings, log, setLogsSnapshotProgress } = useAppStore.getState()
      if (options?.range || options?.groupLabel !== undefined) {
        updateLogsSettings({
          ...(options.range ? { range: options.range } : {}),
          ...(options.groupLabel !== undefined ? { groupLabel: options.groupLabel || undefined } : {}),
        })
      }
      const settings = useAppStore.getState().logsSettings
      const connection = currentConnection(settings)
      if (!connection) throw new Error("Connect a logs source first")
      const key = connectionKey(connection)
      log(`Starting logs snapshot (${settings.range}) against ${connection.baseUrl}`)
      try {
        const snapshot = await fetchLogsSnapshot(connection, {
          range: settings.range,
          groupLabel: settings.groupLabel,
          onProgress: log,
          onStep: setLogsSnapshotProgress,
        })
        return { key, snapshot }
      } finally {
        setLogsSnapshotProgress(null)
      }
    },
    onSuccess: ({ key, snapshot }) => {
      const { setLogsSnapshot, log } = useAppStore.getState()
      if (key !== connectionKey(currentConnection("logs"))) {
        log("Discarded a logs snapshot from a previous connection")
        return
      }
      setLogsSnapshot(snapshot)
      log(`Logs snapshot: ${snapshot.totals.streams.toLocaleString()} streams in ${snapshot.groups.length} ${snapshot.groupLabel} groups`)
    },
    onError: (error) => {
      useAppStore.getState().log(`Logs snapshot failed: ${error.message}`)
      toast.error("Logs snapshot failed", { description: error.message })
    },
  })
  const { mutate } = mutation
  const refresh = React.useCallback(
    (options?: LogsRefreshOptions) => {
      if (queryClient.isMutating({ mutationKey: LOGS_REFRESH_KEY }) > 0) return
      mutate(options)
    },
    [queryClient, mutate]
  )
  return { refresh, isPending: running, error: mutation.error }
}

/** The refresh for a signal's snapshot (the R shortcut and "Refresh snapshot" search action). */
export function useRefreshSignalSnapshot(signal: Signal) {
  const metrics = useRefreshSnapshot()
  const logs = useRefreshLogsSnapshot()
  const refreshLogs = logs.refresh
  const logsRefresh = React.useCallback(() => refreshLogs(), [refreshLogs])
  return signal === "logs" ? { refresh: logsRefresh, isPending: logs.isPending } : metrics
}

/** Total logs bytes per step over a range, from index/volume_range. */
export function useLogsVolumeHistory(range: LogsRange) {
  const connection = useConnection("logs")
  const groupLabel = useAppStore((state) => state.logsSnapshot?.groupLabel)
  return useQuery({
    queryKey: ["logs-volume-history", connectionKey(connection), groupLabel, range],
    enabled: Boolean(connection && groupLabel),
    meta: LOGS_META,
    queryFn: ({ signal }) => fetchLogsVolumeHistory(connection!, groupLabel!, range, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/** Like useSnapshotAge, for the logs snapshot. */
export function useLogsSnapshotAge() {
  const capturedAt = useAppStore((state) => state.logsSnapshot?.capturedAt)
  const host = useAppStore((state) => state.logsSnapshot?.host)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!capturedAt) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [capturedAt])
  return React.useMemo(() => {
    if (!capturedAt) return null
    const at = new Date(capturedAt)
    const ageMs = Math.max(0, now - at.getTime())
    return { capturedAt: at, host: host ?? null, ageMs, label: formatAge(ageMs), stale: ageMs > 24 * 3_600_000 }
  }, [capturedAt, host, now])
}

export function useLogsSnapshotProgress() {
  return useAppStore((state) => state.logsSnapshotProgress)
}

/**
 * Log rule counts and measured byte savings. Reads `logRules` defensively:
 * it is absent until log rules exist in the store.
 */
/** What the active log rules save (the Rules page's computeLogSavings, keeps and overlaps included), plus rule counts. */
export function useLogRuleSavings() {
  const rules = useAppStore((state) => state.logRules)
  const snapshot = useAppStore((state) => state.logsSnapshot)
  return React.useMemo(() => ({ ...computeLogSavings(rules, snapshot), ...logRuleCounts(rules) }), [rules, snapshot])
}
