import { useQuery } from "@tanstack/react-query"

import { connectionKey, LOGS_META, useLogsConnection } from "@/hooks/use-cardinality"
import { SERIES_CAP } from "@/lib/core/logs/impact"
import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LabelMatcher, LogsSnapshot } from "@/lib/core/logs/types"
import { anyValueSelector, streamSelector } from "@/lib/core/logql"
import {
  fetchIndexStats,
  fetchIndexVolume,
  fetchLokiSeries,
  fetchSampleLines,
  type TimeRange,
} from "@/lib/sources/loki"

// Loki reads for the streams, stream group and labels pages. Everything is
// keyed by the connection and the snapshot's window (so numbers line up with
// the snapshot and stay cached). lib/sources/loki.ts keeps at most four
// requests in flight per connection: public Lokis such as Grafana Play are shared.

const STALE = 10 * 60_000
const GC = 30 * 60_000

/** The snapshot's range, ending when it was captured. */
export function snapshotWindow(snapshot: Pick<LogsSnapshot, "capturedAt" | "range">): TimeRange {
  const end = new Date(snapshot.capturedAt).getTime()
  return { start: end - LOGS_RANGE_SECONDS[snapshot.range] * 1000, end }
}

/** Bytes per day at the rate of a window of `rangeSeconds`. */
export function perDay(bytes: number, snapshot: Pick<LogsSnapshot, "range">) {
  return (bytes / LOGS_RANGE_SECONDS[snapshot.range]) * 86400
}

/** The last `minutes`, rounded to 5 minutes so reloads hit the cache. */
function recentWindow(minutes: number): TimeRange {
  const end = Math.floor(Date.now() / 300_000) * 300_000
  return { start: end - minutes * 60_000, end }
}

/** The selector text, or null for no matchers or an invalid one (e.g. a bad `?by=` label). */
function selectorFor(matchers: LabelMatcher[]) {
  try {
    return matchers.length ? streamSelector(matchers) : null
  } catch {
    return null
  }
}

function anyValue(label: string) {
  try {
    return anyValueSelector(label)
  } catch {
    return null
  }
}

export interface GroupRow {
  value: string
  bytes: number
  /** Share of the listed bytes, 0–100. */
  share: number
  /** Known for the snapshot's own grouping; measured per row otherwise. */
  streams?: number
}

/** Bytes per value of `label` over the snapshot's window, from index/volume (streams are measured per row). */
export function useLogGroups(snapshot: LogsSnapshot, label: string, enabled = true) {
  const connection = useLogsConnection()
  const window = snapshotWindow(snapshot)
  return useQuery({
    queryKey: ["logs-groups", connectionKey(connection), label, window.start, window.end],
    enabled: Boolean(connection && anyValue(label)) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    gcTime: GC,
    queryFn: async ({ signal }): Promise<{ rows: GroupRow[]; truncated: boolean }> => {
      const rows = await fetchIndexVolume(connection!, { text: anyValueSelector(label) }, { range: window, targetLabels: [label], limit: 1000, signal })
      const total = rows.reduce((sum, row) => sum + row.bytes, 0)
      return {
        rows: rows
          .map((row) => ({ value: row.labels[label] ?? "", bytes: row.bytes, share: total > 0 ? (row.bytes / total) * 100 : 0 }))
          .filter((row) => row.value !== ""),
        truncated: rows.length >= 1000,
      }
    },
  })
}

/** index/stats (streams, bytes, lines) for a selector over the snapshot's window. */
export function useStreamStats(snapshot: LogsSnapshot, matchers: LabelMatcher[], enabled = true) {
  const connection = useLogsConnection()
  const window = snapshotWindow(snapshot)
  const selector = selectorFor(matchers)
  return useQuery({
    queryKey: ["logs-stats", connectionKey(connection), selector, window.start, window.end],
    enabled: Boolean(connection && selector) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    gcTime: GC,
    queryFn: ({ signal }) => fetchIndexStats(connection!, { text: selector! }, { range: window, signal }),
  })
}

export interface GroupStreams {
  series: Array<Record<string, string>>
  /** More streams matched than were listed. */
  truncated: boolean
  /** The listing covers the last hour only (the group has too many streams for the whole range). */
  lastHourOnly: boolean
}

/**
 * The stream label sets of a selector, capped at SERIES_CAP. A group with more
 * streams than that is listed over its last hour, so the listing stays small.
 */
export function useGroupStreams(snapshot: LogsSnapshot, matchers: LabelMatcher[], knownStreams: number | undefined, enabled = true) {
  const connection = useLogsConnection()
  const window = snapshotWindow(snapshot)
  const selector = selectorFor(matchers)
  const lastHourOnly = (knownStreams ?? 0) > SERIES_CAP && snapshot.range !== "1h"
  const range = lastHourOnly ? { start: window.end - 3600_000, end: window.end } : window
  return useQuery({
    queryKey: ["logs-series", connectionKey(connection), selector, range.start, range.end],
    enabled: Boolean(connection && selector) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    gcTime: GC,
    queryFn: async ({ signal }): Promise<GroupStreams> => {
      const list = await fetchLokiSeries(connection!, { text: selector! }, { range, limit: SERIES_CAP, signal })
      return { series: list.series, truncated: list.truncated, lastHourOnly }
    },
  })
}

/** Bytes per value of `label` within a selector (every stream carrying the label when `matchers` is empty). */
export function useLabelVolume(snapshot: LogsSnapshot, matchers: LabelMatcher[], label: string | null, enabled = true, limit = 25) {
  const connection = useLogsConnection()
  const window = snapshotWindow(snapshot)
  const selector = label === null ? null : (selectorFor(matchers) ?? anyValue(label))
  return useQuery({
    queryKey: ["logs-label-volume", connectionKey(connection), selector, label, limit, window.start, window.end],
    enabled: Boolean(connection && selector) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    gcTime: GC,
    queryFn: async ({ signal }) => {
      const rows = await fetchIndexVolume(connection!, { text: selector! }, { range: window, targetLabels: [label!], limit, signal })
      return rows.map((row) => ({ value: row.labels[label!] ?? "", bytes: row.bytes })).filter((row) => row.value !== "")
    },
  })
}

/** The newest lines of a selector over the last hour. */
export function useSampleLines(matchers: LabelMatcher[], enabled: boolean, limit = 20) {
  const connection = useLogsConnection()
  const selector = selectorFor(matchers)
  return useQuery({
    queryKey: ["logs-sample-lines", connectionKey(connection), selector, limit],
    enabled: Boolean(connection && selector) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    gcTime: GC,
    queryFn: ({ signal }) => fetchSampleLines(connection!, { text: selector! }, { range: recentWindow(60), limit, signal }),
  })
}
