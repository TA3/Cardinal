import { useQuery } from "@tanstack/react-query"

import { connectionKey, LOGS_META, useLogsConnection } from "@/hooks/use-cardinality"
import { anyValueSelector, logQueries } from "@/lib/core/logql"
import { LOGS_RANGE_SECONDS, volumeStepSeconds } from "@/lib/core/logs/snapshot"
import type { LogsRange } from "@/lib/core/logs/types"
import { bytesByValue, topVolumeSeries, volumePeriods, type ValueBytes, type VolumePeriods } from "@/lib/core/logs/volume"
import { literalAlternation } from "@/lib/core/regex"
import { fetchIndexStats, fetchIndexVolume, fetchIndexVolumeRange, fetchLogQueryRange } from "@/lib/sources/loki"
import { useAppStore } from "@/lib/store/app-store"

// Data for the Volume and Patterns pages, cached for five minutes. Loki calls
// go through the shared per-connection limiter in lib/sources/loki.ts.

const STALE = 5 * 60_000

/** The selector the logs snapshot measured, i.e. every stream with the group label. */
export function useSnapshotSelector() {
  return useAppStore((state) => {
    const snapshot = state.logsSnapshot
    if (!snapshot) return null
    return snapshot.selector ?? anyValueSelector(snapshot.groupLabel)
  })
}

export interface VolumeBreakdown {
  periods: VolumePeriods
  current: ValueBytes[]
  /** Null when the previous period had no data at all. */
  previous: ValueBytes[] | null
  streams: { now: number; before: number | null }
}

/** Bytes per value of `by` over the range and the range before it, plus stream counts, from the index. */
export function useVolumeBreakdown(by: string, range: LogsRange) {
  const connection = useLogsConnection()
  const selector = useSnapshotSelector()
  return useQuery({
    queryKey: ["logs-volume-by", connectionKey(connection), selector, by, range],
    enabled: Boolean(connection && selector && by),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }): Promise<VolumeBreakdown> => {
      const periods = volumePeriods(range, Date.now(), volumeStepSeconds(range))
      const text = { text: selector! }
      const volume = (period: VolumePeriods["current"]) =>
        fetchIndexVolume(connection!, text, { range: period, targetLabels: [by], limit: 1000, signal })
      const stats = (period: VolumePeriods["current"]) => fetchIndexStats(connection!, text, { range: period, signal })
      const [now, before, streamsNow, streamsBefore] = await Promise.all([
        volume(periods.current),
        volume(periods.previous),
        stats(periods.current),
        stats(periods.previous).catch(() => null),
      ])
      const previous = bytesByValue(before, by)
      return {
        periods,
        current: bytesByValue(now, by),
        previous: previous.some((item) => item.bytes > 0) ? previous : null,
        streams: { now: streamsNow.streams, before: streamsBefore && streamsBefore.streams > 0 ? streamsBefore.streams : null },
      }
    },
  })
}

/** The five largest values of `by` over time, from index/volume_range. */
export function useVolumeSeries(by: string, range: LogsRange) {
  const connection = useLogsConnection()
  const selector = useSnapshotSelector()
  return useQuery({
    queryKey: ["logs-volume-series", connectionKey(connection), selector, by, range],
    enabled: Boolean(connection && selector && by),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }) => {
      const stepSeconds = volumeStepSeconds(range)
      const { current } = volumePeriods(range, Date.now(), stepSeconds)
      const series = await fetchIndexVolumeRange(connection!, { text: selector! }, { range: current, targetLabels: [by], limit: 5, stepSeconds, signal })
      // The newest bucket still counts chunks being written: leave it out, as the overview does.
      return { ...topVolumeSeries(series, by, { limit: 5, dropFrom: current.end - 1000, dropBefore: current.start + stepSeconds * 1000 }), stepSeconds }
    },
  })
}

/**
 * Checks growth with bytes_over_time for a few values (the index overcounts
 * recent buckets): the last hour against the same hour one range earlier. Two
 * instant queries over one hour each, so it stays cheap for any range.
 */
export function useVerifiedGrowth(by: string, range: LogsRange, values: string[]) {
  const connection = useLogsConnection()
  const usable = values.filter((value) => value !== "").slice(0, 5).sort()
  return useQuery({
    queryKey: ["logs-volume-verify", connectionKey(connection), by, range, usable],
    enabled: Boolean(connection && usable.length),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }) => {
      const hour = 3600
      const end = Math.floor(Date.now() / (hour * 1000)) * hour * 1000
      const query = logQueries.bytesOverTime([{ label: by, op: "=~", value: literalAlternation(usable) }], hour, [by])
      const at = async (t: number) => {
        const result = await fetchLogQueryRange(connection!, query, { range: { start: t, end: t }, stepSeconds: hour, signal })
        const out: Record<string, number> = {}
        if (result.resultType === "matrix") for (const row of result.series) out[row.labels[by] ?? ""] = row.points.at(-1)?.value ?? 0
        return out
      }
      const [now, before] = await Promise.all([at(end), at(end - LOGS_RANGE_SECONDS[range] * 1000)])
      return { now, before, hourEnd: end }
    },
  })
}
