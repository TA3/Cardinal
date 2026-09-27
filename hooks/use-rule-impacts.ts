import * as React from "react"

import { connectionKey } from "@/hooks/use-cardinality"
import { snapshotImpact } from "@/lib/cardinality/dashboard-helpers"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { queries, type SeriesSelector } from "@/lib/core/promql"
import type { Rule, RuleImpact } from "@/lib/core/rules"
import { measureImpact } from "@/lib/sources/prometheus"
import { sendJson, type Connection } from "@/lib/sources/transport"
import { currentConnection, useAppStore } from "@/lib/store/app-store"
import type { PrometheusResponse } from "@/lib/prometheus/types"

// Keeps rule impacts current: metric drops come straight from the snapshot,
// label drops are measured with exact queries so the UI can show real savings
// and flag drops that would merge series.

const DEBOUNCE_MS = 600

function sameImpact(a: RuleImpact | null | undefined, b: RuleImpact | undefined) {
  return a?.seriesBefore === b?.seriesBefore && a?.seriesAfter === b?.seriesAfter && a?.exact === b?.exact
}

/** What a measurement depends on: the rule's target, labels, pattern or buckets, and the backend. */
function workKey(rule: Rule, connKey: string) {
  const detail =
    rule.kind === "drop_labels" ? rule.labels : rule.kind === "keep_buckets" ? rule.buckets : rule.kind === "drop_series" ? [rule.match.label, rule.match.regex] : []
  return JSON.stringify([rule.id, rule.selector.job ?? null, rule.selector.metric, rule.kind, detail, connKey])
}

async function countSeries(connection: Connection, query: string, signal?: AbortSignal) {
  const payload = await sendJson<PrometheusResponse<{ result: Array<{ value: [number, string] }> }>>(connection, {
    path: "/api/v1/query",
    query: { query },
    signal,
  })
  if (payload.status !== "success" || !payload.data) throw new Error(payload.error ?? "Prometheus API returned an error")
  const value = Number(payload.data.result[0]?.value?.[1] ?? 0)
  return Number.isFinite(value) ? value : 0
}

/**
 * Exact impact of any rule. Series drops count the matching series
 * (`count(sel{label=~re})`); bucket keeps count the buckets outside the list.
 * Both remove whole series, so they never merge any.
 */
export async function measureRuleImpact(connection: Connection, rule: Rule, signal?: AbortSignal): Promise<RuleImpact> {
  if (rule.kind !== "drop_series" && rule.kind !== "keep_buckets") return measureImpact(connection, rule, signal)
  const sel: SeriesSelector = {
    metric: rule.selector.metric,
    matchers: rule.selector.job === undefined ? undefined : { job: rule.selector.job },
  }
  const [seriesBefore, removed] = await Promise.all([
    countSeries(connection, queries.seriesCount(sel), signal),
    countSeries(
      connection,
      rule.kind === "drop_series" ? queries.seriesMatching(sel, rule.match.label, rule.match.regex) : queries.bucketsOutside(sel, rule.buckets),
      signal
    ),
  ])
  return {
    seriesBefore,
    seriesAfter: Math.max(0, seriesBefore - removed),
    exact: true,
    mergesSeries: false,
    measuredAt: new Date().toISOString(),
  }
}

export function useRuleImpacts() {
  const rules = useAppStore((state) => state.rules)
  const settings = useAppStore((state) => state.settings)
  const snapshot = useAppStore((state) => state.snapshot)
  const inFlight = React.useRef(new Set<string>())
  const failed = React.useRef(new Set<string>())
  const lastSettings = React.useRef(settings)
  const lastCapturedAt = React.useRef(snapshot?.capturedAt)

  const connKey = connectionKey(currentConnection(settings))

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
    useAppStore.getState().invalidateImpacts()
  }, [snapshot?.capturedAt])

  // Metric drops: read from the snapshot, never queried.
  React.useEffect(() => {
    const { setRuleImpact } = useAppStore.getState()
    for (const rule of rules) {
      if (rule.kind !== "drop_metric" || rule.status === "rejected") continue
      const impact = snapshotImpact(rule, snapshot)
      if (impact && !sameImpact(impact, rule.impact)) setRuleImpact(rule.id, impact)
    }
  }, [rules, snapshot])

  // Label, series and bucket rules: measured against the backend.
  React.useEffect(() => {
    const connection = currentConnection(settings)
    if (!connection) return
    const pending = rules.filter(
      (rule) =>
        rule.kind !== "drop_metric" &&
        rule.status !== "rejected" &&
        !rule.impact &&
        !inFlight.current.has(workKey(rule, connKey)) &&
        !failed.current.has(workKey(rule, connKey))
    )
    if (pending.length === 0) return

    const timer = setTimeout(() => {
      for (const rule of pending) inFlight.current.add(workKey(rule, connKey))
      void runWithConcurrency(
        pending,
        async (rule) => {
          const key = workKey(rule, connKey)
          try {
            const impact = await measureRuleImpact(connection, rule)
            // Apply only if the rule and the connection are still what was measured.
            const state = useAppStore.getState()
            const current = state.rules.find((item) => item.id === rule.id)
            const stillConnected = connectionKey(currentConnection(state.settings)) === connKey
            if (current && stillConnected && workKey(current, connKey) === key) state.setRuleImpact(rule.id, impact)
          } catch {
            // Leave unmeasured (the heuristic estimate still applies) and don't
            // retry until the rule, the connection or the snapshot changes.
            failed.current.add(key)
          } finally {
            inFlight.current.delete(key)
          }
        },
        3
      )
    }, DEBOUNCE_MS)

    // Started measurements are left to finish: each one updates `rules`,
    // which re-runs this effect, and aborting would discard finished work.
    return () => clearTimeout(timer)
  }, [rules, settings, connKey])
}
