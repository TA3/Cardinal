import * as React from "react"

import { connectionKey } from "@/hooks/use-cardinality"
import { runWithConcurrency } from "@/lib/core/concurrency"
import {
  computeLogRuleImpact,
  logImpactQueries,
  queryResultValue,
  SERIES_CAP,
  snapshotLogImpact,
} from "@/lib/core/logs/impact"
import { logRuleKey } from "@/lib/core/logs/rules"
import { DEFAULT_LOGS_RANGE, LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogRule, LogRuleImpact, LogsRange, StreamSelector } from "@/lib/core/logs/types"
import { fetchIndexStats, fetchLogQueryRange, fetchLokiSeries, timeRangeFor } from "@/lib/sources/loki"
import type { Connection } from "@/lib/sources/transport"
import { currentConnection, useAppStore } from "@/lib/store/app-store"

// Keeps log rule impacts current, like use-rule-impacts.ts for metrics:
// stream drops on one group come straight from the snapshot, everything else
// is measured against Loki (index/stats, bytes_over_time, series) over the
// snapshot's range, so the savings compare with the snapshot totals.

const DEBOUNCE_MS = 600
/** Gentle on shared Lokis (Grafana Play): at most this many rules measured at once, 2 requests each. */
const CONCURRENCY = 2
/** Label rules list streams; above this many the listing is skipped and the rule stays unmeasured. */
const MAX_STREAMS_TO_LIST = 20_000

export interface LogMeasureOptions {
  range: LogsRange
  /** The snapshot's group label; `{label=~".+"}` stands in for an empty (all streams) selector. */
  groupLabel?: string
  signal?: AbortSignal
  now?: number
}

function everythingFor(groupLabel: string | undefined): StreamSelector | undefined {
  return groupLabel ? { matchers: [{ label: groupLabel, op: "=~", value: ".+" }] } : undefined
}

/**
 * Line filters scan raw lines, so over a long range they are measured on the
 * last hour only and scaled by the selector's bytes: gentle on shared Lokis,
 * and an estimate.
 */
const SAMPLE_RANGE: LogsRange = "1h"

async function metricValue(connection: Connection, query: string, range: LogsRange, end: number, signal?: AbortSignal) {
  // One evaluation at the range end: the step is the whole range.
  const result = await fetchLogQueryRange(connection, query, {
    range: { start: end - 1000, end },
    stepSeconds: LOGS_RANGE_SECONDS[range],
    signal,
  })
  if (result.resultType !== "matrix") return null
  return queryResultValue({
    resultType: "matrix",
    result: result.series.map((series) => ({ values: series.points.map((point) => [point.t / 1000, String(point.value)]) })),
  })
}

/**
 * Measures one log rule against Loki over `range`: index/stats for the
 * selector, plus the filtered bytes (line rules) or the stream listing (label
 * rules). Throws when Loki fails; returns null when the rule can't be measured
 * (too many streams to list).
 */
export async function measureLogRuleImpact(connection: Connection, rule: LogRule, options: LogMeasureOptions): Promise<LogRuleImpact | null> {
  const { range: rangeKey, signal } = options
  const range = timeRangeFor(rangeKey, options.now)
  const everything = everythingFor(options.groupLabel)
  const queries = logImpactQueries(rule, { range: rangeKey, everything })
  const scaled = Boolean(queries.bytes) && rangeKey !== SAMPLE_RANGE
  const sampleQueries = scaled ? logImpactQueries(rule, { range: SAMPLE_RANGE, everything }) : queries
  const sampleRange = scaled ? timeRangeFor(SAMPLE_RANGE, range.end) : range
  const [stats, sampleStats, matched] = await Promise.all([
    fetchIndexStats(connection, { text: queries.stats }, { range, signal }),
    scaled ? fetchIndexStats(connection, { text: queries.stats }, { range: sampleRange, signal }) : Promise.resolve(null),
    sampleQueries.bytes ? metricValue(connection, sampleQueries.bytes, scaled ? SAMPLE_RANGE : rangeKey, range.end, signal) : Promise.resolve(undefined),
  ])
  let matchedBytes = matched
  let viaLineText = false
  if (sampleQueries.bytesFallback && (matchedBytes === null || matchedBytes === 0)) {
    const fallback = await metricValue(connection, sampleQueries.bytesFallback, scaled ? SAMPLE_RANGE : rangeKey, range.end, signal)
    if (fallback !== null && (matchedBytes === null || fallback > 0)) {
      matchedBytes = fallback
      viaLineText = true
    }
  }
  // A filter matching no lines at all returns no samples: that is 0 bytes, not unknown.
  if (queries.bytes && matchedBytes === null) matchedBytes = 0
  // The last hour's matched share, applied to the whole range.
  if (scaled && matchedBytes !== undefined && matchedBytes !== null) {
    const share = sampleStats && sampleStats.bytes > 0 ? Math.min(1, matchedBytes / sampleStats.bytes) : 0
    matchedBytes = share * stats.bytes
  }
  let series: Array<Record<string, string>> | undefined
  if (queries.series) {
    if (stats.streams > MAX_STREAMS_TO_LIST) return null
    series = (await fetchLokiSeries(connection, { text: queries.series }, { range, limit: SERIES_CAP, signal })).series
  }
  const impact = computeLogRuleImpact(rule, {
    stats,
    matchedBytes,
    viaLineText,
    series,
    seriesCap: SERIES_CAP,
    rangeDays: LOGS_RANGE_SECONDS[rangeKey] / 86400,
  })
  if (!impact || !scaled) return impact
  const note = `Line share measured over the last hour and applied to the ${rangeKey}.`
  return { ...impact, exact: false, note: impact.note ? `${impact.note} ${note}` : note }
}

function sameImpact(a: LogRuleImpact | null | undefined, b: LogRuleImpact | undefined) {
  return (
    a?.bytesBefore === b?.bytesBefore &&
    a?.bytesAfter === b?.bytesAfter &&
    a?.streamsBefore === b?.streamsBefore &&
    a?.streamsAfter === b?.streamsAfter &&
    a?.exact === b?.exact
  )
}

/** What a measurement depends on: the rule's target and settings, the range and the backend. */
function workKey(rule: LogRule, connKey: string, range: string) {
  const setting = rule.kind === "sample" ? rule.keep : rule.kind === "retention" ? rule.days : null
  return JSON.stringify([rule.id, logRuleKey(rule), setting, range, connKey])
}

/** Rules whose impact the snapshot gives exactly: a stream drop on exactly one group. */
function fromSnapshot(rule: LogRule) {
  return rule.kind === "drop_streams" && rule.selector.matchers.length === 1
}

export function useLogRuleImpacts() {
  const rules = useAppStore((state) => state.logRules)
  const settings = useAppStore((state) => state.logsSettings)
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const inFlight = React.useRef(new Set<string>())
  const failed = React.useRef(new Set<string>())
  const lastSettings = React.useRef(settings)
  const lastCapturedAt = React.useRef(snapshot?.capturedAt)

  const connKey = connectionKey(currentConnection(settings))
  const range = snapshot?.range ?? settings.range ?? DEFAULT_LOGS_RANGE
  const groupLabel = snapshot?.groupLabel

  // New settings (backend, token, …) get a clean slate of failures.
  React.useEffect(() => {
    if (lastSettings.current !== settings) failed.current.clear()
    lastSettings.current = settings
  }, [settings])

  // A refreshed snapshot makes every measurement stale.
  React.useEffect(() => {
    if (snapshot?.capturedAt === lastCapturedAt.current) return
    lastCapturedAt.current = snapshot?.capturedAt
    failed.current.clear()
    useAppStore.getState().invalidateLogImpacts()
  }, [snapshot?.capturedAt])

  // Stream drops on one group: read from the snapshot when it has that group.
  React.useEffect(() => {
    const { setLogRuleImpact } = useAppStore.getState()
    for (const rule of rules) {
      if (rule.status === "rejected" || !fromSnapshot(rule)) continue
      const impact = snapshotLogImpact(rule, snapshot)
      if (impact && !sameImpact(impact, rule.impact)) setLogRuleImpact(rule.id, impact)
    }
  }, [rules, snapshot])

  // Everything else: measured against Loki.
  React.useEffect(() => {
    const connection = currentConnection(settings)
    if (!connection || !snapshot) return
    const pending = rules.filter((rule) => {
      if (rule.status === "rejected" || rule.impact) return false
      if (fromSnapshot(rule) && snapshotLogImpact(rule, snapshot)) return false
      const key = workKey(rule, connKey, range)
      return !inFlight.current.has(key) && !failed.current.has(key)
    })
    if (pending.length === 0) return

    const timer = setTimeout(() => {
      for (const rule of pending) inFlight.current.add(workKey(rule, connKey, range))
      void runWithConcurrency(
        pending,
        async (rule) => {
          const key = workKey(rule, connKey, range)
          try {
            const impact = await measureLogRuleImpact(connection, rule, { range, groupLabel })
            if (!impact) {
              failed.current.add(key)
              return
            }
            // Apply only if the rule, the range and the connection are still what was measured.
            const state = useAppStore.getState()
            const current = state.logRules.find((item) => item.id === rule.id)
            const stillConnected = connectionKey(currentConnection(state.logsSettings)) === connKey
            const currentRange = state.logsSnapshot?.range ?? state.logsSettings.range
            if (current && stillConnected && workKey(current, connKey, currentRange) === key) state.setLogRuleImpact(rule.id, impact)
          } catch {
            // Leave unmeasured and don't retry until the rule, the connection or the snapshot changes.
            failed.current.add(key)
          } finally {
            inFlight.current.delete(key)
          }
        },
        CONCURRENCY
      )
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [rules, settings, snapshot, connKey, range, groupLabel])
}
