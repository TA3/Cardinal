import { activeRules, isShadowed, type Rule, type RuleImpact } from "@/lib/core/rules"
import { snapshotSeries, type Snapshot } from "@/lib/core/snapshot"
import type { MetricDrilldown, SnapshotResponse } from "@/lib/prometheus/types"

/** Any snapshot shape: persisted legacy ones lack the per-job counts. */
export type SnapshotLike = Pick<SnapshotResponse, "metrics" | "totalSeries" | "capturedAt"> &
  Pick<Snapshot, "seriesByMetricJob">

/** Signed change, e.g. "+1,200" or "−340"; rounds first so it never prints "−0". */
export function formatDelta(value: number) {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0
  if (rounded === 0) return "0"
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toLocaleString()}`
}

export interface Savings {
  savedSeries: number
  percent: number
  isEstimate: boolean
}

/**
 * Impact of a drop_metric rule straight from the snapshot, which counts every
 * series per job and metric, so no query is needed. Null for drop_labels (it
 * must be measured) or when a legacy snapshot has no per-job counts.
 */
export function snapshotImpact(
  rule: Pick<Rule, "kind" | "selector">,
  snapshot: SnapshotLike | null
): RuleImpact | null {
  if (rule.kind !== "drop_metric" || !snapshot) return null
  const seriesBefore = snapshotSeries(snapshot, rule.selector.metric, rule.selector.job)
  if (seriesBefore === undefined) return null
  return {
    seriesBefore,
    seriesAfter: 0,
    exact: true,
    mergesSeries: false,
    measuredAt: snapshot.capturedAt ?? new Date().toISOString(),
  }
}

/**
 * Series removed by the active rules. Uses measured impacts where available,
 * then exact snapshot counts (metric drops), then a conservative label
 * heuristic, and flags the result as an estimate when any rule needed one.
 */
export function computeExpectedSavings(
  rules: Rule[],
  snapshot: SnapshotLike | null,
  drilldowns: Record<string, MetricDrilldown>
): Savings {
  const active = activeRules(rules)
  if (!snapshot || active.length === 0) {
    return { savedSeries: 0, percent: 0, isEstimate: false }
  }
  const seriesByMetric = new Map(snapshot.metrics.map((m) => [m.metric, m.seriesCount]))

  // Per metric, then per job scope (null = every job). Within a scope a metric
  // drop replaces label drops (isShadowed skips those); scopes are summed.
  const saved = new Map<string, Map<string | null, { dropped?: number; labels: number }>>()
  let isEstimate = false

  for (const rule of active) {
    if (isShadowed(rule, active)) continue
    const { metric, job } = rule.selector
    const scopes = saved.get(metric) ?? new Map()
    saved.set(metric, scopes)
    const scope = scopes.get(job ?? null) ?? { labels: 0 }
    scopes.set(job ?? null, scope)

    if (rule.kind === "drop_metric") {
      const impact = rule.impact ?? snapshotImpact(rule, snapshot)
      if (!impact) {
        isEstimate = true
        continue
      }
      if (!impact.exact) isEstimate = true
      scope.dropped = impact.seriesBefore
      continue
    }

    if (rule.impact) {
      if (!rule.impact.exact) isEstimate = true
      scope.labels += Math.max(0, rule.impact.seriesBefore - rule.impact.seriesAfter)
      continue
    }
    // Heuristic until measured: assume the strongest label is independent.
    isEstimate = true
    // Series and bucket drops have no cheap estimate; they count once measured.
    if (rule.kind !== "drop_labels") continue
    const total = snapshotSeries(snapshot, metric, job) ?? seriesByMetric.get(metric) ?? 0
    let best = 0
    for (const label of rule.labels) {
      const cardinality = drilldowns[metric]?.labels.find((item) => item.label === label)?.cardinality ?? 1
      best = Math.max(best, cardinality > 1 ? total * (1 - 1 / cardinality) : 0)
    }
    scope.labels += best
  }

  let savedSeries = 0
  for (const [metric, scopes] of saved) {
    const all = scopes.get(null)
    let metricSaved = 0
    if (all?.dropped !== undefined) {
      metricSaved = all.dropped
    } else {
      for (const scope of scopes.values()) metricSaved += scope.dropped ?? scope.labels
    }
    const total = seriesByMetric.get(metric)
    savedSeries += total === undefined ? metricSaved : Math.min(metricSaved, total)
  }
  const percent = snapshot.totalSeries > 0 ? Math.min(100, (savedSeries / snapshot.totalSeries) * 100) : 0
  return { savedSeries: Math.round(savedSeries), percent, isEstimate }
}
