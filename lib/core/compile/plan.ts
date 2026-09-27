import { jobLabel } from "@/lib/core/jobs"
import { activeRules, isShadowed, sortUnique, type Rule } from "@/lib/core/rules"

// Turns a RuleSet into a target-independent relabel plan that the Prometheus
// and Alloy emitters render. Lossy label drops are excluded here: relabelling
// them away produces duplicate series, so they belong in an aggregation target.

export type RelabelMode = "combined" | "split-by-job"

export interface RelabelOptions {
  mode: RelabelMode
  /** Every job emitting each metric; used to place unscoped rules per job. */
  jobsByMetric?: Record<string, string[]>
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

export type RelabelStep = RelabelDrop | RelabelLabelClear | RelabelSeriesDrop | RelabelKeepBuckets

/**
 * Temporary label marking kept buckets. RE2 has no negation, so "drop le not
 * in the list" is: mark the kept buckets, drop unmarked ones, remove the mark.
 * The `__tmp` prefix is reserved for exactly this by Prometheus.
 */
export const KEEP_BUCKET_MARK = "__tmp_cardinal_keep_le"

export interface RelabelSection {
  /** Scrape job this section belongs in; undefined = applies globally, "" = series without a job. */
  job?: string
  steps: RelabelStep[]
}

export interface RelabelPlan {
  sections: RelabelSection[]
  warnings: string[]
}

export function planRelabel(rules: Rule[], options: RelabelOptions): RelabelPlan {
  const warnings: string[] = []
  const active = activeRules(rules)

  const drops: Array<{ job?: string; metric: string }> = []
  const clears: Array<{ job?: string; metric: string; label: string }> = []
  const extras: Array<RelabelSeriesDrop | RelabelKeepBuckets> = []

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
    const target = `${rule.selector.metric}${rule.selector.job !== undefined ? ` (job ${jobLabel(rule.selector.job)})` : ""}`
    if (rule.impact?.mergesSeries) {
      warnings.push(
        `Skipped dropping [${rule.labels.join(", ")}] on ${target}: it merges series, which relabelling turns into duplicate samples. Use an Adaptive Metrics aggregation instead.`
      )
      continue
    }
    if (!rule.impact) {
      warnings.push(
        `Dropping [${rule.labels.join(", ")}] on ${target} has not been checked for series merges. Measure its impact before applying.`
      )
    }
    for (const label of rule.labels) {
      clears.push({ job: rule.selector.job, metric: rule.selector.metric, label })
    }
  }

  if (options.mode === "combined") {
    return { sections: [{ steps: buildSteps(drops, clears, extras) }], warnings }
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

  return { sections, warnings }
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
  extras: Array<RelabelSeriesDrop | RelabelKeepBuckets> = []
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
