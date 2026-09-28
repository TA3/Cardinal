import { jobLabel } from "@/lib/core/jobs"
import { activeRules, isShadowed, sortUnique, type DropLabelsRule, type Rule } from "@/lib/core/rules"

// Turns a RuleSet into a target-independent relabel plan that the Prometheus
// and Alloy emitters render. A label drop that merges series follows the
// rule's `onMerge` choice; one without a choice (or one asking to aggregate
// where the target can't) is held back in `blocked` for the UI to resolve.

export type RelabelMode = "combined" | "split-by-job"

export interface RelabelOptions {
  mode: RelabelMode
  /** Every job emitting each metric; used to place unscoped rules per job. */
  jobsByMetric?: Record<string, string[]>
  /** Aggregations become recording rules plus a drop of the raw metric (remote write only). */
  aggregate?: boolean
}

export interface RelabelDrop {
  kind: "drop"
  /** undefined = every job; "" = series without a job label. */
  job?: string
  metrics: string[]
}

export interface RelabelLabelClear {
  kind: "clear_label"
  job?: string
  metric: string
  label: string
}

/** Drops the series of a metric whose `label` matches `regex`. */
export interface RelabelSeriesDrop {
  kind: "drop_series"
  job?: string
  metric: string
  label: string
  regex: string
}

/** Drops every `le` bucket of a metric except `buckets`. */
export interface RelabelKeepBuckets {
  kind: "keep_buckets"
  job?: string
  metric: string
  buckets: string[]
}

/** Drops the series of a metric whose `label` is set to anything but `value`. */
export interface RelabelKeepValue {
  kind: "keep_value"
  job?: string
  metric: string
  label: string
  value: string
}

export type RelabelStep = RelabelDrop | RelabelLabelClear | RelabelSeriesDrop | RelabelKeepBuckets | RelabelKeepValue
type RelabelExtra = RelabelSeriesDrop | RelabelKeepBuckets | RelabelKeepValue

/** A recording rule summing a metric without some labels; the raw metric is dropped from what's shipped. */
export interface Aggregation {
  job?: string
  metric: string
  labels: string[]
}

/** A merging label drop the plan left out: no choice yet, or "aggregate" where the target can't. */
export interface BlockedRule {
  rule: DropLabelsRule
  reason: "undecided" | "aggregate"
}

/**
 * Temporary label marking kept buckets. RE2 has no negation, so "drop le not
 * in the list" is: mark the kept buckets, drop unmarked ones, remove the mark.
 * The `__tmp` prefix is reserved for exactly this by Prometheus.
 */
export const KEEP_BUCKET_MARK = "__tmp_cardinal_keep_le"
/** The same trick for keeping one value of a label. */
export const KEEP_VALUE_MARK = "__tmp_cardinal_keep_value"

export interface RelabelSection {
  /** Scrape job this section belongs in; undefined = applies globally, "" = series without a job. */
  job?: string
  steps: RelabelStep[]
}

export interface RelabelPlan {
  sections: RelabelSection[]
  warnings: string[]
  blocked: BlockedRule[]
  aggregations: Aggregation[]
}

export function planRelabel(rules: Rule[], options: RelabelOptions): RelabelPlan {
  const warnings: string[] = []
  const blocked: BlockedRule[] = []
  const aggregations: Aggregation[] = []
  const active = activeRules(rules)

  const drops: Array<{ job?: string; metric: string }> = []
  const clears: Array<{ job?: string; metric: string; label: string }> = []
  const extras: RelabelExtra[] = []

  for (const rule of active) {
    if (rule.kind === "drop_metric") {
      drops.push({ job: rule.selector.job, metric: rule.selector.metric })
      continue
    }
    if (isShadowed(rule, active)) continue
    if (rule.kind === "drop_series") {
      extras.push({ kind: "drop_series", job: rule.selector.job, metric: rule.selector.metric, ...rule.match })
      continue
    }
    if (rule.kind === "keep_buckets") {
      extras.push({ kind: "keep_buckets", job: rule.selector.job, metric: rule.selector.metric, buckets: rule.buckets })
      continue
    }
    const { job, metric } = rule.selector
    const merges = Boolean(rule.impact?.mergesSeries)
    const choice = rule.onMerge
    const target = `[${rule.labels.join(", ")}] on ${metric}${job !== undefined ? ` (job ${jobLabel(job)})` : ""}`
    if (merges && !choice) {
      blocked.push({ rule, reason: "undecided" })
      warnings.push(`Left out ${target}: dropping it merges series. Choose drop anyway, keep one value or aggregate.`)
      continue
    }
    if (choice === "aggregate" && (merges || !rule.impact)) {
      if (!options.aggregate) {
        blocked.push({ rule, reason: "aggregate" })
        warnings.push(`Left out ${target}: aggregating needs remote write or Grafana Cloud. Choose drop anyway or keep one value here.`)
        continue
      }
      drops.push({ job, metric })
      aggregations.push({ job, metric, labels: rule.labels })
      continue
    }
    if (choice === "keep_value") {
      for (const label of rule.labels) {
        const value = rule.keepValues?.[label]
        if (value !== undefined && value !== "") extras.push({ kind: "keep_value", job, metric, label, value })
      }
    }
    for (const label of rule.labels) clears.push({ job, metric, label })
  }
  aggregations.sort((a, b) => a.metric.localeCompare(b.metric) || compareJobs(a.job, b.job))

  if (options.mode === "combined") {
    return { sections: [{ steps: buildSteps(drops, clears, extras) }], warnings, blocked, aggregations }
  }

  // split-by-job: one section per scrape job. Rules without a job are placed
  // in every job known to emit the metric (or a global section when unknown).
  // Steps stay scoped to their job: every Alloy component forwards to the same
  // receiver, and a scoped Prometheus rule still round-trips losslessly.
  const perJob = new Map<string | undefined, { drops: typeof drops; clears: typeof clears; extras: typeof extras }>()
  const bucket = (job: string | undefined) => {
    let entry = perJob.get(job)
    if (!entry) {
      entry = { drops: [], clears: [], extras: [] }
      perJob.set(job, entry)
    }
    return entry
  }
  const jobsFor = (job: string | undefined, metric: string): Array<string | undefined> => {
    if (job !== undefined) return [job]
    const known = options.jobsByMetric?.[metric]
    return known?.length ? known : [undefined]
  }

  for (const drop of drops) {
    for (const job of jobsFor(drop.job, drop.metric)) bucket(job).drops.push({ job, metric: drop.metric })
  }
  for (const clear of clears) {
    for (const job of jobsFor(clear.job, clear.metric)) bucket(job).clears.push({ ...clear, job })
  }
  for (const extra of extras) {
    for (const job of jobsFor(extra.job, extra.metric)) bucket(job).extras.push({ ...extra, job })
  }

  const sections = Array.from(perJob.entries())
    .sort(([a], [b]) => compareJobs(a, b))
    .map(([job, entry]) => ({ job, steps: buildSteps(entry.drops, entry.clears, entry.extras) }))

  return { sections, warnings, blocked, aggregations }
}

/** Orders undefined (every job) first, then "" (no job), then by name. */
function compareJobs(a: string | undefined, b: string | undefined) {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  return a.localeCompare(b)
}

/**
 * Order matters: metric drops, then series drops and bucket keeps (which read
 * label values), then label clears last so they never hide a value an earlier
 * step matches on.
 */
function buildSteps(
  drops: Array<{ job?: string; metric: string }>,
  clears: Array<{ job?: string; metric: string; label: string }>,
  extras: RelabelExtra[] = []
): RelabelStep[] {
  const steps: RelabelStep[] = []

  const dropsByJob = new Map<string | undefined, string[]>()
  for (const { job, metric } of drops) {
    dropsByJob.set(job, [...(dropsByJob.get(job) ?? []), metric])
  }
  const jobOrder = Array.from(dropsByJob.keys()).sort(compareJobs)
  for (const job of jobOrder) {
    steps.push({ kind: "drop", job, metrics: sortUnique(dropsByJob.get(job) ?? []) })
  }

  const seenExtras = new Set<string>()
  const sortedExtras = [...extras].sort(
    (a, b) => a.metric.localeCompare(b.metric) || compareJobs(a.job, b.job) || a.kind.localeCompare(b.kind)
  )
  for (const extra of sortedExtras) {
    const key = JSON.stringify(extra)
    if (seenExtras.has(key)) continue
    seenExtras.add(key)
    steps.push(extra)
  }

  const seen = new Set<string>()
  const sortedClears = [...clears].sort(
    (a, b) =>
      a.metric.localeCompare(b.metric) ||
      compareJobs(a.job, b.job) ||
      a.label.localeCompare(b.label)
  )
  for (const clear of sortedClears) {
    const key = JSON.stringify([clear.job ?? null, clear.metric, clear.label])
    if (seen.has(key)) continue
    seen.add(key)
    steps.push({ kind: "clear_label", ...clear })
  }

  return steps
}
