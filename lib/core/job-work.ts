import { jobLabel } from "@/lib/core/jobs"
import type { JobMetric } from "@/lib/core/keep-list"
import { activateOrCreate, isKept, type KeepMetricsRule, type MergeChoice, type MetricRule, type Rule } from "@/lib/core/rules"
import { guardedLabel } from "@/lib/core/usage-gate"

// Going through a job by hand: every metric of the job with what the plan
// already does to it there, what that saves, and whether it is done (cut, or
// kept as it is on purpose). Rules for every job count too: they apply here.

/** open: not looked at yet; cut: rules change it; dropped: gone from the job; kept: kept as it is on purpose. */
export type MetricWorkState = "open" | "cut" | "dropped" | "kept"

export interface MetricWork {
  metric: string
  /** Series of the metric in this job. */
  seriesCount: number
  /** Active rules that change the metric in this job: its own and every job's. */
  rules: MetricRule[]
  /** The job's keep-list drops it. */
  byKeepList: boolean
  savedSeries: number
  /** A rule is not measured yet, so `savedSeries` may be low. */
  unmeasured: boolean
  state: MetricWorkState
}

export interface JobWork {
  job: string
  metrics: MetricWork[]
  seriesCount: number
  savedSeries: number
  unmeasured: boolean
  /** Metrics that are cut, dropped or kept on purpose. */
  done: number
  keepList?: KeepMetricsRule
}

/** Active rules for `metric` that apply in `job` (the job's own or every job's). */
export function rulesInJob(rules: readonly Rule[], metric: string, job: string): MetricRule[] {
  return rules.filter(
    (rule): rule is MetricRule =>
      rule.status === "active" &&
      rule.kind !== "keep_metrics" &&
      rule.selector.metric === metric &&
      (rule.selector.job === undefined || rule.selector.job === job)
  )
}

/** Series a rule saves in `job`: its measured saving, scaled to the job's share when it applies to every job. */
function savedInJob(rule: MetricRule, seriesInJob: number) {
  if (!rule.impact) return null
  const saved = Math.max(0, rule.impact.seriesBefore - rule.impact.seriesAfter)
  if (rule.selector.job !== undefined || rule.impact.seriesBefore <= 0) return saved
  return saved * Math.min(1, seriesInJob / rule.impact.seriesBefore)
}

export function buildJobWork({
  job,
  metrics,
  rules,
  kept,
}: {
  job: string
  /** Every metric of the job with its series in the job. */
  metrics: readonly JobMetric[]
  rules: readonly Rule[]
  /** Metrics marked "keep as is" for this job. */
  kept: readonly string[]
}): JobWork {
  const keepList = rules.find((rule): rule is KeepMetricsRule => rule.kind === "keep_metrics" && rule.status === "active" && rule.selector.job === job)
  const keptSet = new Set(kept)
  let savedSeries = 0
  let unmeasured = false
  let done = 0

  const rows = metrics.map((item): MetricWork => {
    const applying = rulesInJob(rules, item.metric, job)
    const byKeepList = keepList ? !isKept(item.metric, keepList.metrics) : false
    const droppedWhole = byKeepList || applying.some((rule) => rule.kind === "drop_metric")
    let saved = 0
    let pending = false
    if (droppedWhole) {
      saved = item.seriesCount
    } else {
      for (const rule of applying) {
        const value = savedInJob(rule, item.seriesCount)
        if (value === null) pending = true
        else saved += value
      }
      saved = Math.min(item.seriesCount, Math.round(saved))
    }
    const state: MetricWorkState = droppedWhole ? "dropped" : applying.length ? "cut" : keptSet.has(item.metric) ? "kept" : "open"
    if (state !== "open") done += 1
    savedSeries += saved
    unmeasured ||= pending
    return { metric: item.metric, seriesCount: item.seriesCount, rules: applying, byKeepList, savedSeries: saved, unmeasured: pending, state }
  })

  return {
    job,
    metrics: rows,
    seriesCount: metrics.reduce((sum, item) => sum + item.seriesCount, 0),
    savedSeries,
    unmeasured,
    done,
    keepList,
  }
}

/** Series of one metric of a job before and after a label is removed from the whole job. */
export interface JobLabelRow {
  metric: string
  seriesBefore: number
  seriesAfter: number
}

/**
 * Where series merge: "skip" leaves those metrics alone (the label goes only
 * where every series stays distinct); a MergeChoice removes it there too and
 * handles the merge that way.
 */
export type JobLabelMerge = "skip" | Exclude<MergeChoice, "keep_value">

/** Labels a whole job never loses: buckets, the job, targets and names (see GUARDED_LABELS). */
export function removableJobLabel(label: string) {
  return !guardedLabel(label) && label !== "quantile"
}

/** The metrics removing a label from a job touches, and what it saves, for a merge choice. */
export function jobLabelPlan(rows: readonly JobLabelRow[], merge: JobLabelMerge) {
  const merging = rows.filter((row) => row.seriesAfter < row.seriesBefore)
  const targets = merge === "skip" ? rows.filter((row) => row.seriesAfter >= row.seriesBefore) : [...rows]
  return {
    targets,
    merging,
    savedSeries: targets.reduce((sum, row) => sum + Math.max(0, row.seriesBefore - row.seriesAfter), 0),
  }
}

/** Adds (or extends) a job-scoped label drop for every target metric. */
export function addJobLabelDrops(
  rules: Rule[],
  { job, label, targets, merge, measuredAt }: { job: string; label: string; targets: readonly JobLabelRow[]; merge: JobLabelMerge; measuredAt: string }
): Rule[] {
  let next = rules
  for (const row of targets) {
    const merges = row.seriesAfter < row.seriesBefore
    next = activateOrCreate(next, {
      kind: "drop_labels",
      selector: { metric: row.metric, job },
      labels: [label],
      origin: "user",
      rationale: `Removed ${label} from every metric of job ${jobLabel(job)}${merges ? "" : ": every series stays distinct without it"}.`,
      ...(merges && merge !== "skip" ? { onMerge: merge } : {}),
      impact: { seriesBefore: row.seriesBefore, seriesAfter: row.seriesAfter, exact: true, mergesSeries: merges, measuredAt },
    })
  }
  return next
}
