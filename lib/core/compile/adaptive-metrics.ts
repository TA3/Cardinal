import { jobLabel } from "@/lib/core/jobs"
import { activeRules, createRule, isShadowed, sortUnique, type Rule, type RuleImpact } from "@/lib/core/rules"

// Grafana Cloud Adaptive Metrics aggregation rules. Unlike relabel rules these
// aggregate series server-side, so dropping labels that distinguish series is
// safe here: merged series are summed instead of colliding.

export interface AggregationRule {
  metric: string
  match_type?: "" | "exact" | "prefix" | "suffix" | "regex"
  drop?: boolean
  keep_labels?: string[]
  drop_labels?: string[]
  aggregations?: string[]
  aggregation_interval?: string
  aggregation_delay?: string
  managed_by?: string
}

export interface AdaptiveRecommendation extends AggregationRule {
  recommended_action: "add" | "update" | "remove" | "keep" | string
  usages_in_rules?: number
  usages_in_queries?: number
  usages_in_dashboards?: number
  kept_labels?: string[]
  total_series_after_aggregation?: number
  total_series_before_aggregation?: number
}

export type AdaptiveChange =
  | { type: "add"; rule: AggregationRule }
  | { type: "update"; before: AggregationRule; rule: AggregationRule }

export interface AdaptiveCompileResult {
  rules: AggregationRule[]
  changes: AdaptiveChange[]
  warnings: string[]
}

const COUNTER_SUFFIXES = ["_total", "_count", "_sum", "_bucket"]

/**
 * Default aggregations when the metric type is unknown: counters keep a
 * rate-able sum, everything else keeps sum+count so averages still work.
 */
export function defaultAggregations(metric: string) {
  return COUNTER_SUFFIXES.some((suffix) => metric.endsWith(suffix)) ? ["sum:counter"] : ["sum", "count"]
}

function sameRule(a: AggregationRule, b: AggregationRule) {
  const norm = (rule: AggregationRule) =>
    JSON.stringify({
      drop: Boolean(rule.drop),
      drop_labels: sortUnique(rule.drop_labels ?? []),
      keep_labels: sortUnique(rule.keep_labels ?? []),
      aggregations: sortUnique(rule.aggregations ?? []),
    })
  return norm(a) === norm(b)
}

const matchType = (rule: AggregationRule) => rule.match_type || "exact"
const existingKey = (rule: AggregationRule) => `${matchType(rule)}|${rule.metric}`

/** True when a non-exact existing rule (prefix, suffix, regex) also applies to `metric`. */
function overlaps(rule: AggregationRule, metric: string) {
  switch (matchType(rule)) {
    case "prefix":
      return metric.startsWith(rule.metric)
    case "suffix":
      return metric.endsWith(rule.metric)
    case "regex":
      try {
        return new RegExp(`^(?:${rule.metric})$`).test(metric)
      } catch {
        return false
      }
    default:
      return false
  }
}

/**
 * Merges Cardinal rules into an existing Adaptive Metrics ruleset. Only exact
 * rules for the same metric are updated; every other existing rule is kept
 * as-is (the API replaces the whole set on write), and prefix/suffix/regex
 * rules that also match a metric are left untouched with a warning.
 */
export function compileAdaptiveMetrics(
  rules: Rule[],
  existing: AggregationRule[] = []
): AdaptiveCompileResult {
  const warnings: string[] = []
  const active = activeRules(rules)
  const desired = new Map<string, AggregationRule>()

  for (const rule of active) {
    const metric = rule.selector.metric
    if (rule.selector.job !== undefined) {
      warnings.push(
        `${metric}: rule is scoped to job ${jobLabel(rule.selector.job)}, but Adaptive Metrics rules apply to every job. Skipped; use a relabel rule or a segment.`
      )
      continue
    }
    if (rule.kind === "drop_metric") {
      desired.set(metric, { metric, drop: true })
      continue
    }
    if (isShadowed(rule, active)) continue
    if (rule.kind === "drop_series" || rule.kind === "keep_buckets") {
      warnings.push(
        `${metric}: ${rule.kind === "drop_series" ? `dropping series where ${rule.match.label} matches a pattern` : "keeping only some le buckets"} can't be expressed as an Adaptive Metrics aggregation. Skipped; export it as Prometheus or Alloy relabel config.`
      )
      continue
    }
    const current = desired.get(metric)
    if (current?.drop) continue
    desired.set(metric, {
      metric,
      drop_labels: sortUnique([...(current?.drop_labels ?? []), ...rule.labels]),
      aggregations: defaultAggregations(metric),
    })
  }

  const exactIndex = new Map<string, number>()
  existing.forEach((rule, index) => {
    const key = existingKey(rule)
    if (!exactIndex.has(key)) exactIndex.set(key, index)
    else if (matchType(rule) === "exact") {
      warnings.push(`${rule.metric}: the existing ruleset has more than one exact rule; only the first is updated.`)
    }
  })

  const merged: AggregationRule[] = [...existing]
  const added: AggregationRule[] = []
  const changes: AdaptiveChange[] = []
  for (const [metric, rule] of desired) {
    for (const other of existing) {
      if (overlaps(other, metric)) {
        warnings.push(
          `${metric}: existing ${matchType(other)} rule "${other.metric}" also matches this metric; it is left unchanged.`
        )
      }
    }

    const index = exactIndex.get(`exact|${metric}`)
    if (index === undefined) {
      changes.push({ type: "add", rule })
      added.push(rule)
      continue
    }
    const before = existing[index]

    let next: AggregationRule
    if (rule.drop) {
      next = { metric, ...(before.match_type ? { match_type: before.match_type } : {}), drop: true }
    } else if (before.drop) {
      warnings.push(`${metric}: an existing rule already drops this metric; it is left unchanged.`)
      continue
    } else {
      if (before.keep_labels?.length) {
        warnings.push(`${metric}: existing rule uses keep_labels; it will be replaced by a drop_labels rule.`)
      }
      next = {
        ...before,
        drop_labels: sortUnique([...(before.keep_labels?.length ? [] : (before.drop_labels ?? [])), ...(rule.drop_labels ?? [])]),
        aggregations: before.aggregations?.length ? before.aggregations : rule.aggregations,
      }
      delete next.keep_labels
    }
    if (sameRule(before, next)) continue
    changes.push({ type: "update", before, rule: next })
    merged[index] = next
  }

  return {
    rules: [...merged, ...added].sort((a, b) => a.metric.localeCompare(b.metric)),
    changes,
    warnings,
  }
}

export function renderAdaptiveMetrics(result: AdaptiveCompileResult) {
  return `${JSON.stringify(
    result.changes.map((change) => change.rule),
    null,
    2
  )}\n`
}

export function recommendationSavings(rec: AdaptiveRecommendation) {
  const before = rec.total_series_before_aggregation ?? 0
  const after = rec.drop ? 0 : (rec.total_series_after_aggregation ?? before)
  return Math.max(0, before - after)
}

/** Turns an actionable recommendation into a proposed Cardinal rule. */
export function recommendationToRule(rec: AdaptiveRecommendation): Rule | null {
  if (rec.recommended_action !== "add" && rec.recommended_action !== "update") return null
  const usage = `used in ${rec.usages_in_dashboards ?? 0} dashboards, ${rec.usages_in_queries ?? 0} queries, ${rec.usages_in_rules ?? 0} rules`
  const impact: RuleImpact | undefined =
    rec.total_series_before_aggregation !== undefined
      ? {
          seriesBefore: rec.total_series_before_aggregation,
          seriesAfter: rec.drop ? 0 : (rec.total_series_after_aggregation ?? rec.total_series_before_aggregation),
          exact: true,
          mergesSeries: !rec.drop,
          measuredAt: new Date().toISOString(),
        }
      : undefined
  const base = { selector: { metric: rec.metric }, origin: "import" as const, status: "proposed" as const }
  if (rec.drop) {
    return { ...createRule({ ...base, kind: "drop_metric", rationale: `Adaptive Metrics recommendation (${usage}).` }), impact }
  }
  if (rec.drop_labels?.length) {
    return {
      ...createRule({
        ...base,
        kind: "drop_labels",
        labels: rec.drop_labels,
        rationale: `Adaptive Metrics recommendation, aggregating with ${rec.aggregations?.join(", ") ?? "defaults"} (${usage}).`,
      }),
      impact,
    }
  }
  return null
}

/** An aggregation rule in words, e.g. "drop" or "drop labels pod, uid · sum:counter". */
export function describeAggregation(rule: AggregationRule) {
  if (rule.drop) return "drop the metric"
  const parts: string[] = []
  if (rule.drop_labels?.length) parts.push(`drop labels ${rule.drop_labels.join(", ")}`)
  if (rule.keep_labels?.length) parts.push(`keep only ${rule.keep_labels.join(", ")}`)
  if (rule.aggregations?.length) parts.push(`aggregate with ${rule.aggregations.join(", ")}`)
  return parts.join(" · ") || "no change"
}

export interface AdaptiveChangeDiff {
  metric: string
  type: AdaptiveChange["type"]
  /** The remote rule before this apply; null for a new rule. */
  before: string | null
  after: string
  /** Labels this apply newly drops, and ones it stops dropping. */
  addedLabels: string[]
  removedLabels: string[]
  aggregations: string[]
}

/** Per-rule before/after for the apply dialog. */
export function adaptiveChangeDiffs(changes: AdaptiveChange[]): AdaptiveChangeDiff[] {
  return changes.map((change) => {
    const before = change.type === "update" ? change.before : null
    const was = new Set(before?.drop_labels ?? [])
    const now = new Set(change.rule.drop_labels ?? [])
    return {
      metric: change.rule.metric,
      type: change.type,
      before: before ? describeAggregation(before) : null,
      after: describeAggregation(change.rule),
      addedLabels: [...now].filter((label) => !was.has(label)).sort(),
      removedLabels: [...was].filter((label) => !now.has(label)).sort(),
      aggregations: change.rule.drop ? [] : (change.rule.aggregations ?? []),
    }
  })
}

/** What Cardinal keeps before an apply so it can be undone. */
export interface AdaptiveBackup {
  appliedAt: string
  /** The remote rule set before the apply, and its ETag. */
  previous: AggregationRule[]
  previousEtag: string
  /** What the apply wrote, to detect edits made since. */
  applied: AggregationRule[]
  changes: number
}

/** Order- and formatting-independent form of a rule set, for comparing. */
export function canonicalRules(rules: AggregationRule[]) {
  const canon = (rule: AggregationRule) => {
    const out: Record<string, unknown> = { metric: rule.metric, match_type: rule.match_type || "exact" }
    for (const [key, value] of Object.entries(rule)) {
      if (key === "metric" || key === "match_type" || value === undefined || value === "" || value === false) continue
      if (Array.isArray(value)) {
        if (value.length) out[key] = [...value].sort()
      } else out[key] = value
    }
    return JSON.stringify(out, Object.keys(out).sort())
  }
  return rules.map(canon).sort()
}

export function sameRuleset(a: AggregationRule[], b: AggregationRule[]) {
  const left = canonicalRules(a)
  const right = canonicalRules(b)
  return left.length === right.length && left.every((rule, index) => rule === right[index])
}

export type RevertPlan =
  | { ok: true; rules: AggregationRule[]; etag: string }
  | { ok: false; reason: string }

/**
 * Restoring the previous rule set is only safe while the remote set is still
 * what Cardinal applied; anything else means someone changed it since, and a
 * revert would silently discard their change. The write then carries the
 * current ETag as If-Match, so a change racing the revert is rejected too.
 */
export function planRevert(backup: AdaptiveBackup | null, current: AggregationRule[], currentEtag: string): RevertPlan {
  if (!backup) return { ok: false, reason: "There is no apply to revert." }
  if (!sameRuleset(current, backup.applied)) {
    return {
      ok: false,
      reason: "The Adaptive Metrics rules changed after Cardinal applied them, so reverting would overwrite someone else's change.",
    }
  }
  return { ok: true, rules: backup.previous, etag: currentEtag }
}
