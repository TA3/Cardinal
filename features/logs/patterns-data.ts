import { useQueries, useQuery } from "@tanstack/react-query"

import { connectionKey, LOGS_META, useLogsConnection } from "@/hooks/use-cardinality"
import { logQueries } from "@/lib/core/logql"
import { renderLogSelector } from "@/lib/core/logs/selector"
import type { LabelMatcher } from "@/lib/core/logs/types"
import { fetchIndexStats, fetchLogQueryRange, fetchPatterns, type LogPattern } from "@/lib/sources/loki"
import type { Connection } from "@/lib/sources/transport"

// Patterns come from Loki's pattern ingester, which keeps about three hours,
// so the page offers 1h and 3h. Queries are shared between the single-service
// view and "all top services", so switching never refetches.

export type PatternRange = "1h" | "3h"
export const PATTERN_RANGES: readonly PatternRange[] = ["1h", "3h"]
export const PATTERN_RANGE_SECONDS: Record<PatternRange, number> = { "1h": 3600, "3h": 3 * 3600 }

const STALE = 5 * 60_000

function alignedEnd(stepSeconds: number) {
  return Math.floor(Date.now() / (stepSeconds * 1000)) * stepSeconds * 1000
}

/** About 30 sparkline points per range. */
export function patternStepSeconds(range: PatternRange) {
  return PATTERN_RANGE_SECONDS[range] / 30
}

export function serviceMatchers(groupLabel: string, service: string): LabelMatcher[] {
  return [{ label: groupLabel, op: "=", value: service }]
}

function patternsQuery(connection: Connection | null, groupLabel: string | undefined, service: string | undefined, range: PatternRange) {
  return {
    queryKey: ["logs-patterns", connectionKey(connection), groupLabel, service, range],
    enabled: Boolean(connection && groupLabel && service),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ServicePatterns> => {
      const stepSeconds = patternStepSeconds(range)
      const end = alignedEnd(stepSeconds)
      const window = { start: end - PATTERN_RANGE_SECONDS[range] * 1000, end }
      const matchers = serviceMatchers(groupLabel!, service!)
      const [patterns, stats] = await Promise.all([
        fetchPatterns(connection!, matchers, { range: window, stepSeconds, signal }),
        fetchIndexStats(connection!, matchers, { range: window, signal }).catch(() => null),
      ])
      return {
        patterns,
        lines: stats?.entries || null,
        bytesPerDay: stats?.bytes ? (stats.bytes / PATTERN_RANGE_SECONDS[range]) * 86400 : null,
      }
    },
  }
}

export interface ServicePatterns {
  /** Null when this Loki has no pattern ingester. */
  patterns: LogPattern[] | null
  /** Lines the service logged in the window (index/stats; reads high). */
  lines: number | null
  /** The service's bytes per day at the window's rate (index/stats; reads high). */
  bytesPerDay: number | null
}

/** Patterns for one service, with its line and byte totals over the same window. */
export function usePatterns(groupLabel: string | undefined, service: string | undefined, range: PatternRange) {
  const connection = useLogsConnection()
  return useQuery(patternsQuery(connection, groupLabel, service, range))
}

/**
 * Patterns for several services, through the shared Loki limiter (four at a
 * time per connection); each lands in the same cache
 * as the single-service view.
 */
export function useServicesPatterns(groupLabel: string | undefined, services: string[], range: PatternRange, enabled: boolean) {
  const connection = useLogsConnection()
  return useQueries({
    queries: services.map((service) => {
      const query = patternsQuery(connection, groupLabel, service, range)
      return { ...query, enabled: query.enabled && enabled }
    }),
  }).map((result, index) => ({ ...result, service: services[index] }))
}

/** Up to five recent lines of the service matching the pattern's regex. */
export function usePatternExamples(groupLabel: string, service: string, regex: string | null, range: PatternRange, enabled: boolean) {
  const connection = useLogsConnection()
  return useQuery({
    queryKey: ["logs-pattern-examples", connectionKey(connection), groupLabel, service, regex, range],
    enabled: Boolean(connection && regex && enabled),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }) => {
      const end = alignedEnd(60)
      const query = renderLogSelector({ matchers: serviceMatchers(groupLabel, service) }, { regex: regex! })
      const result = await fetchLogQueryRange(connection!, query, { range: { start: end - PATTERN_RANGE_SECONDS[range] * 1000, end: Date.now() }, limit: 5, direction: "backward", signal })
      return result.resultType === "streams" ? result.lines : []
    },
  })
}

/**
 * The pattern's share of the service's bytes over the last 15 minutes, from
 * bytes_over_time with and without its line filter: a measured check on the
 * line-share estimate. Small window, so it stays cheap.
 */
export function usePatternByteShare(groupLabel: string, service: string, regex: string | null, enabled: boolean) {
  const connection = useLogsConnection()
  return useQuery({
    queryKey: ["logs-pattern-bytes", connectionKey(connection), groupLabel, service, regex],
    enabled: Boolean(connection && regex && enabled),
    meta: LOGS_META,
    retry: false,
    staleTime: STALE,
    queryFn: async ({ signal }) => {
      const window = 15 * 60
      const t = alignedEnd(60)
      const selector = { matchers: serviceMatchers(groupLabel, service) }
      const all = logQueries.bytesOverTime(selector, window)
      const matched = `sum (bytes_over_time(${renderLogSelector(selector, { regex: regex! })} [${window / 60}m]))`
      const value = async (query: string) => {
        const result = await fetchLogQueryRange(connection!, query, { range: { start: t, end: t }, stepSeconds: window, signal })
        return result.resultType === "matrix" ? (result.series[0]?.points.at(-1)?.value ?? 0) : 0
      }
      const [total, part] = await Promise.all([value(all), value(matched)])
      return { total, matched: part, share: total > 0 ? Math.min(1, part / total) : null, windowSeconds: window }
    },
  })
}
