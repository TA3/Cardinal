import { roughReductionSavings, suggestBuckets, type ClassicHistogram } from "@/lib/core/histograms"
import { histogramFamily } from "@/lib/core/families"
import type { IdLikeVerdict } from "@/lib/core/id-like"
import { logRuleKey, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LogRule, LogRuleStatus } from "@/lib/core/logs/types"
import type { MergeChoice, Rule, RuleStatus } from "@/lib/core/rules"
import { guardedLabel } from "@/lib/core/usage-gate"

// "Top savings": concrete things to cut, ranked by what they save, each with
// the rule a one-click Propose creates. Pure: the Overview hooks gather the
// evidence (usage, label values, histograms, churn) and hand it here.

export type OpportunityReason = "unused" | "id_like" | "buckets" | "churn"

export const REASON_LABEL: Record<OpportunityReason, string> = {
  unused: "Unused",
  id_like: "ID-like",
  buckets: "Buckets",
  churn: "Churn",
}

/** The rule a metric opportunity proposes. */
export type OpportunityRule =
  | { kind: "drop_metric"; metric: string; job?: string }
  | { kind: "drop_labels"; metric: string; job?: string; labels: string[]; onMerge?: MergeChoice }
  | { kind: "keep_buckets"; metric: string; job?: string; buckets: string[] }

export interface MetricOpportunity {
  /** Stable identity, e.g. for React keys. */
  id: string
  reason: OpportunityReason
  metric: string
  job?: string
  label?: string
  /** Series the rule removes. */
  savedSeries: number
  /** True unless measured exactly (snapshot counts or a PromQL count). */
  estimate: boolean
  rule: OpportunityRule
  /** One sentence for the proposed rule's rationale. */
  rationale: string
  /** Usage was only checked against alerting and recording rules, not dashboards. */
  rulesOnly?: boolean
}

/** The chip for an opportunity; "Unused" only when dashboards were checked too. */
export function reasonLabel(item: Pick<MetricOpportunity, "reason" | "rulesOnly">) {
  return item.reason === "unused" && item.rulesOnly ? "Not in rules" : REASON_LABEL[item.reason]
}

/** Where a shown opportunity stands: nothing done yet, or a proposal waiting in Rules. */
export type OpportunityState = "open" | "proposed"

const idOf = (reason: OpportunityReason, metric: string, job?: string, label?: string) => JSON.stringify([reason, metric, job ?? null, label ?? null])

/** Metrics worth checking for usage: the largest ones, above a floor. */
export function bigMetrics<T extends { metric: string; seriesCount: number }>(metrics: T[], { limit = 20, minSeries = 50 } = {}): T[] {
  return [...metrics]
    .filter((item) => item.seriesCount >= minSeries)
    .sort((a, b) => b.seriesCount - a.seriesCount || a.metric.localeCompare(b.metric))
    .slice(0, limit)
}

/**
 * Big metrics nothing is known to use. `used` maps metric → true (used),
 * false (checked, unused) or undefined (unknown: evidence missing); only
 * checked-and-unused metrics become opportunities.
 */
export function unusedMetricOpportunities(
  metrics: Array<{ metric: string; seriesCount: number }>,
  used: Record<string, boolean | undefined>,
  { dashboardsChecked = true }: { dashboardsChecked?: boolean } = {}
): MetricOpportunity[] {
  return metrics
    .filter((item) => used[item.metric] === false && item.seriesCount > 0)
    .map((item) => ({
      id: idOf("unused", item.metric),
      reason: "unused" as const,
      metric: item.metric,
      savedSeries: item.seriesCount,
      estimate: false,
      rule: { kind: "drop_metric" as const, metric: item.metric },
      rationale: dashboardsChecked
        ? `No alerting or recording rule or scanned dashboard uses ${item.metric} (${item.seriesCount.toLocaleString("en-US")} series).`
        : `No alerting or recording rule uses ${item.metric} (${item.seriesCount.toLocaleString("en-US")} series); dashboards weren't checked.`,
      rulesOnly: !dashboardsChecked,
    }))
}

/** Labels of a metric worth an ID check: the highest-cardinality ones that may be dropped. */
export function idCheckCandidates(labels: Array<{ label: string; cardinality: number }>, { limit = 2, minValues = 20 } = {}) {
  return labels
    .filter((item) => item.cardinality >= minValues && !guardedLabel(item.label) && item.label !== "le")
    .sort((a, b) => b.cardinality - a.cardinality || a.label.localeCompare(b.label))
    .slice(0, limit)
}

/**
 * An ID-like label on a metric, once measured. Nothing when dropping it saves
 * no series. Merging drops default to "drop anyway" when the label is unused.
 */
export function idLikeOpportunity(input: {
  metric: string
  label: string
  verdict: IdLikeVerdict
  impact: { seriesBefore: number; seriesAfter: number; mergesSeries: boolean }
  /** False when nothing is known to use the metric (so nothing groups by the label). */
  used: boolean | undefined
}): MetricOpportunity | null {
  const { metric, label, impact } = input
  const saved = impact.seriesBefore - impact.seriesAfter
  if (!(saved > 0)) return null
  return {
    id: idOf("id_like", metric, undefined, label),
    reason: "id_like",
    metric,
    label,
    savedSeries: saved,
    estimate: false,
    rule: {
      kind: "drop_labels",
      metric,
      labels: [label],
      ...(impact.mergesSeries && input.used === false ? { onMerge: "drop" as const } : {}),
    },
    rationale: `${label} looks like ${input.verdict.kind === "path" ? "paths with IDs" : "IDs"} (${Math.round(input.verdict.share * 100)}% of its top values): ${impact.seriesBefore.toLocaleString("en-US")} → ${impact.seriesAfter.toLocaleString("en-US")} series without it.`,
  }
}

/** Keep this many finite buckets when trimming from the Overview. */
const TRIM_TARGET = 6

/**
 * Classic histograms with more buckets than they need: keep a log-spaced
 * handful (the bucket picker refines it with the distribution). Estimates.
 */
export function bucketOpportunities(families: ClassicHistogram[], { minSaved = 50 } = {}): MetricOpportunity[] {
  const result: MetricOpportunity[] = []
  for (const family of families) {
    const saving = roughReductionSavings(family, TRIM_TARGET)
    if (saving.saved < minSaved) continue
    const kept = suggestBuckets(family.les, [], { target: TRIM_TARGET }).kept
    result.push({
      id: idOf("buckets", family.bucketMetric),
      reason: "buckets",
      metric: family.bucketMetric,
      savedSeries: saving.saved,
      estimate: true,
      rule: { kind: "keep_buckets", metric: family.bucketMetric, buckets: kept },
      rationale: `Keeps ${kept.length} of ${family.les.length} buckets of ${family.base} (≈ ${saving.saved.toLocaleString("en-US")} series, an estimate).`,
    })
  }
  return result
}

/** A churning (metric, job) pair and the label whose values come and go. */
export function churnOpportunity(input: {
  metric: string
  job: string
  label: string
  churned: number
  used: boolean | undefined
}): MetricOpportunity | null {
  const { metric, job, label, churned } = input
  if (!(churned > 0) || guardedLabel(label) || (label === "le" && histogramFamily(metric).part === "bucket")) return null
  return {
    id: idOf("churn", metric, job, label),
    reason: "churn",
    metric,
    job,
    label,
    savedSeries: churned,
    estimate: true,
    rule: { kind: "drop_labels", metric, job, labels: [label], ...(input.used === false ? { onMerge: "drop" as const } : {}) },
    rationale: `${label} drives the churn of ${metric}: ${churned.toLocaleString("en-US")} series came and went in the last hour.`,
  }
}

/** True when `rule` already does what the opportunity would (same metric, a scope at least as wide). */
export function ruleCovers(rule: Rule, candidate: OpportunityRule) {
  if (rule.selector.metric !== candidate.metric) return false
  if (rule.selector.job !== undefined && rule.selector.job !== candidate.job) return false
  if (rule.kind === "drop_metric") return true
  if (candidate.kind === "drop_labels") return rule.kind === "drop_labels" && candidate.labels.every((label) => rule.labels.includes(label))
  if (candidate.kind === "keep_buckets") return rule.kind === "keep_buckets"
  return false
}

/** The status of the strongest rule covering the candidate: active beats proposed beats rejected. */
function coveringStatus(rules: Rule[], candidate: OpportunityRule): RuleStatus | null {
  let found: RuleStatus | null = null
  for (const rule of rules) {
    if (!ruleCovers(rule, candidate)) continue
    if (rule.status === "active") return "active"
    if (rule.status === "proposed" || found === null) found = rule.status
  }
  return found
}

const REASON_ORDER: OpportunityReason[] = ["unused", "id_like", "buckets", "churn"]

/**
 * Ranks opportunities by series saved. Items a rule already handles (active)
 * or the user turned down (rejected) are gone; pending proposals stay, marked
 * "proposed". A metric that can go whole hides its smaller label and bucket
 * items, and the same label found twice (ID-like and churn) shows once.
 */
export function rankOpportunities(items: MetricOpportunity[], rules: Rule[] = []): Array<MetricOpportunity & { state: OpportunityState }> {
  const wholeMetric = new Set(items.filter((item) => item.rule.kind === "drop_metric").map((item) => item.metric))
  const best = new Map<string, MetricOpportunity>()
  for (const item of items) {
    if (item.rule.kind !== "drop_metric" && wholeMetric.has(item.metric)) continue
    const key = item.label ? JSON.stringify([item.metric, item.label]) : item.id
    const current = best.get(key)
    if (!current || item.savedSeries > current.savedSeries) best.set(key, item)
  }
  const ranked: Array<MetricOpportunity & { state: OpportunityState }> = []
  for (const item of best.values()) {
    const status = coveringStatus(rules, item.rule)
    if (status === "active" || status === "rejected") continue
    ranked.push({ ...item, state: status === "proposed" ? "proposed" : "open" })
  }
  return ranked.sort(
    (a, b) =>
      b.savedSeries - a.savedSeries ||
      REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
      a.metric.localeCompare(b.metric) ||
      (a.label ?? "").localeCompare(b.label ?? "")
  )
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogOpportunityReason = "noisy" | "debug" | "labels"

export const LOG_REASON_LABEL: Record<LogOpportunityReason, string> = {
  noisy: "Noisy",
  debug: "Debug",
  labels: "Labels",
}

export interface LogOpportunity {
  id: string
  reason: LogOpportunityReason
  /** What the row names: a service, a pattern, or a label. */
  title: string
  /** Secondary text, e.g. the service a pattern belongs to. */
  subtitle?: string
  /** Bytes per day the rule saves; null for label moves, which save streams. */
  savedBytesPerDay: number | null
  /** Streams it removes (label moves). */
  savedStreams?: number
  estimate: boolean
  rule: LogRuleInput
}

const DEBUG_LEVELS = new Set(["debug", "trace"])

export interface ServicePatternInput {
  service: string
  patterns: Array<{ pattern: string; level?: string; lineShare: number; bytesPerDay: number | null; regex: string | null }>
}

/** Keep this share of a noisy pattern's lines. */
export const NOISY_KEEP = 0.1

/**
 * From each service's ranked patterns: its biggest non-error pattern when it
 * is a large share of the service (sample it), and its debug/trace lines when
 * they add up to something (drop them).
 */
export function patternOpportunities(
  groupLabel: string,
  services: ServicePatternInput[],
  { minShare = 0.15, minDebugShare = 0.05, minBytesPerDay = 1024 * 1024 } = {}
): LogOpportunity[] {
  const result: LogOpportunity[] = []
  for (const { service, patterns } of services) {
    const selector = { matchers: [{ label: groupLabel, op: "=" as const, value: service }] }
    const debug = patterns.filter((item) => item.level && DEBUG_LEVELS.has(item.level.toLowerCase()))
    const debugShare = debug.reduce((sum, item) => sum + item.lineShare, 0)
    const debugBytes = debug.reduce((sum, item) => sum + (item.bytesPerDay ?? 0), 0)
    if (debugShare >= minDebugShare && debugBytes >= minBytesPerDay) {
      result.push({
        id: JSON.stringify(["debug", service]),
        reason: "debug",
        title: service,
        subtitle: "debug + trace lines",
        savedBytesPerDay: debugBytes,
        estimate: true,
        rule: {
          kind: "drop_lines",
          selector,
          line: { levels: ["debug", "trace"] },
          origin: "user",
          rationale: `Debug and trace lines are about ${(debugShare * 100).toFixed(0)}% of ${service}'s lines.`,
        },
      })
    }
    const noisy = patterns.find(
      (item) => item.regex && !/err|crit|fatal|panic|warn/i.test(item.level ?? "") && !DEBUG_LEVELS.has((item.level ?? "").toLowerCase())
    )
    if (noisy && noisy.regex && noisy.lineShare >= minShare && (noisy.bytesPerDay ?? 0) * (1 - NOISY_KEEP) >= minBytesPerDay) {
      result.push({
        id: JSON.stringify(["noisy", service, noisy.pattern]),
        reason: "noisy",
        title: noisy.pattern,
        subtitle: service,
        savedBytesPerDay: (noisy.bytesPerDay ?? 0) * (1 - NOISY_KEEP),
        estimate: true,
        rule: {
          kind: "sample",
          selector,
          line: { regex: noisy.regex },
          keep: NOISY_KEEP,
          origin: "user",
          rationale: `One pattern is about ${(noisy.lineShare * 100).toFixed(0)}% of ${service}'s lines; keeping ${NOISY_KEEP * 100}% of it cuts about ${100 - NOISY_KEEP * 100}% of that.`,
        },
      })
    }
  }
  return result
}

/** Stream labels to move to structured metadata (label advice "strong"). */
export function labelOpportunities(
  labels: Array<{ label: string; distinctValues: number; idLike?: boolean; move: boolean; streams?: number; streamsIfMoved?: number }>
): LogOpportunity[] {
  return labels
    .filter((item) => item.move)
    .map((item) => ({
      id: JSON.stringify(["labels", item.label]),
      reason: "labels" as const,
      title: item.label,
      subtitle: `${item.distinctValues.toLocaleString("en-US")} values${item.idLike ? ", ID-like" : ""}`,
      savedBytesPerDay: null,
      savedStreams:
        item.streams !== undefined && item.streamsIfMoved !== undefined ? Math.max(0, item.streams - item.streamsIfMoved) : undefined,
      estimate: true,
      rule: {
        kind: "label_to_metadata" as const,
        selector: { matchers: [] },
        label: item.label,
        origin: "user" as const,
        rationale: `${item.label} has ${item.distinctValues.toLocaleString("en-US")} values${item.idLike ? " that look like IDs" : ""}; as structured metadata it stays searchable without creating streams.`,
      },
    }))
}

/**
 * Ranks log opportunities: byte savings first (largest first), then label
 * moves by streams. Rules that already exist hide them (active, rejected)
 * or mark them "proposed", matched by rule identity.
 */
export function rankLogOpportunities(items: LogOpportunity[], rules: LogRule[] = []): Array<LogOpportunity & { state: OpportunityState }> {
  const statusByKey = new Map<string, LogRuleStatus>()
  for (const rule of rules) {
    const key = logRuleKey(rule)
    const current = statusByKey.get(key)
    if (current === "active") continue
    if (rule.status === "active" || rule.status === "proposed" || !current) statusByKey.set(key, rule.status)
  }
  const ranked: Array<LogOpportunity & { state: OpportunityState }> = []
  for (const item of items) {
    const status = statusByKey.get(logRuleKey(item.rule))
    if (status === "active" || status === "rejected") continue
    ranked.push({ ...item, state: status === "proposed" ? "proposed" : "open" })
  }
  return ranked.sort(
    (a, b) =>
      (b.savedBytesPerDay ?? -1) - (a.savedBytesPerDay ?? -1) ||
      (b.savedStreams ?? 0) - (a.savedStreams ?? 0) ||
      a.title.localeCompare(b.title)
  )
}
