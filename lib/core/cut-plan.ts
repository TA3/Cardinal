import type { Assessment } from "@/lib/core/decide/risk"
import { jobMetrics, SELF_METRIC, suggestKeepList, type JobMetric } from "@/lib/core/keep-list"
import type { MetricOpportunity, OpportunityState } from "@/lib/core/opportunities"
import { isKept, type KeepMetricsRule, type Rule } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"

// The Plan: every cut Cardinal can stand behind, grouped by scrape job, so a
// job is decided as a whole (an exporter is usually one decision: keep what
// is used). Each cut says what it does in plain words, what it saves and why.

/** What Cardinal knows about usage, for the whole backend. */
export interface UsageCoverage {
  /** Alerting and recording rules were read. */
  rules: boolean
  /** Dashboards were scanned (or Grafana Cloud usage, which covers queries). */
  dashboards: boolean
}

export type CutState = OpportunityState | "active"

interface CutBase {
  id: string
  /** null: the metric spans several jobs. */
  job: string | null
  savedSeries: number
  estimate: boolean
  risk: Assessment
  state: CutState
}

export interface KeepListCut extends CutBase {
  kind: "keep_list"
  job: string
  keep: string[]
  drop: JobMetric[]
  selfMetrics: number
  /** Series per metric of the job, kept or not. */
  series: Record<string, number>
  /** The keep-list already in the plan, when there is one. */
  rule?: KeepMetricsRule
}

export interface SelfMetricsCut extends CutBase {
  kind: "self_metrics"
  job: string
  metrics: JobMetric[]
}

export interface OpportunityCut<T extends MetricOpportunity = MetricOpportunity> extends CutBase {
  kind: "opportunity"
  item: T & { state: CutState; risk: Assessment }
}

export type PlanCut<T extends MetricOpportunity = MetricOpportunity> = KeepListCut | SelfMetricsCut | OpportunityCut<T>

export interface JobPlan<T extends MetricOpportunity = MetricOpportunity> {
  /** null: cuts on metrics several jobs emit. */
  job: string | null
  seriesCount: number
  cuts: PlanCut<T>[]
  /** What the open cuts save together (keep-lists already cover the metric drops they include). */
  openSavings: number
  /** The same for every cut, added or not: jobs keep their place as cuts are added. */
  totalSavings: number
}

/** Below this, a keep-list or self-metrics cut isn't worth a decision. */
const MIN_SERIES = 20

function coverageAssessment(coverage: UsageCoverage, what: string[]): Assessment {
  const complete = coverage.rules && coverage.dashboards
  return {
    level: complete ? "safe" : "review",
    confidence: (coverage.rules ? 0.5 : 0) + (coverage.dashboards ? 0.5 : 0),
    why: [
      ...what,
      ...(complete
        ? []
        : [coverage.dashboards ? "Alerting and recording rules weren't checked." : "Dashboards weren't checked, so a panel may still read them."]),
    ],
    ...(complete ? {} : { missing: coverage.dashboards ? ("usage" as const) : ("dashboards" as const) }),
  }
}

function keepListCut(
  job: string,
  metrics: JobMetric[],
  used: Record<string, boolean | undefined>,
  coverage: UsageCoverage,
  active?: KeepMetricsRule,
  proposed?: KeepMetricsRule,
  min = MIN_SERIES
): KeepListCut | null {
  const rule = active ?? proposed
  const suggestion = suggestKeepList(metrics, used)
  const keep = rule ? rule.metrics : suggestion.keep
  const drop = rule ? metrics.filter((item) => !isKept(item.metric, rule.metrics)) : suggestion.drop
  const savedSeries = drop.reduce((sum, item) => sum + item.seriesCount, 0)
  if (!rule && savedSeries < min) return null
  const selfMetrics = drop.filter((item) => SELF_METRIC.test(item.metric)).length
  return {
    id: JSON.stringify(["keep_list", job]),
    kind: "keep_list",
    job,
    keep,
    drop,
    selfMetrics,
    series: Object.fromEntries(metrics.map((item) => [item.metric, item.seriesCount])),
    savedSeries,
    estimate: false,
    rule,
    state: active ? "active" : proposed ? "proposed" : "open",
    risk: coverageAssessment(coverage, [
      `${drop.length} metric${drop.length === 1 ? "" : "s"} no dashboard or rule reads.`,
      "Metrics a new exporter version adds stay out until you keep them.",
    ]),
  }
}

function selfMetricsCut(
  job: string,
  metrics: JobMetric[],
  used: Record<string, boolean | undefined>,
  coverage: UsageCoverage,
  rules: Rule[],
  min = MIN_SERIES
): SelfMetricsCut | null {
  const self = metrics.filter((item) => SELF_METRIC.test(item.metric) && used[item.metric] !== true)
  const savedSeries = self.reduce((sum, item) => sum + item.seriesCount, 0)
  if (self.length === 0 || savedSeries < min) return null
  const dropped = (metric: string) =>
    rules.some(
      (rule) =>
        rule.kind === "drop_metric" && rule.selector.metric === metric && (rule.selector.job === undefined || rule.selector.job === job) && rule.status === "active"
    )
  return {
    id: JSON.stringify(["self_metrics", job]),
    kind: "self_metrics",
    job,
    metrics: self,
    savedSeries,
    estimate: false,
    state: self.every((item) => dropped(item.metric)) ? "active" : "open",
    risk: coverageAssessment(coverage, ["They describe the exporter process, not what it monitors."]),
  }
}

/** A job's keep-list to edit by hand, whatever it saves: the active one, else Cardinal's suggestion. */
export function jobKeepListCut(job: string, metrics: JobMetric[], used: Record<string, boolean | undefined>, coverage: UsageCoverage, rules: Rule[]): KeepListCut {
  const active = rules.find((rule): rule is KeepMetricsRule => rule.kind === "keep_metrics" && rule.status === "active" && rule.selector.job === job)
  return keepListCut(job, metrics, used, coverage, active, undefined, 0)!
}

/** The job's own Go and process metrics, whatever they save; null when it has none. */
export function jobSelfMetricsCut(job: string, metrics: JobMetric[], used: Record<string, boolean | undefined>, coverage: UsageCoverage, rules: Rule[]) {
  return selfMetricsCut(job, metrics, used, coverage, rules, 1)
}

/**
 * Builds the plan. `used` holds usage per metric only where it can be
 * trusted (true, false, or undefined when unknown); keep-lists are only
 * suggested when both rules and dashboards were checked, and otherwise the
 * exporter's own Go and process metrics are the job-level cut.
 */
export function buildCutPlan<T extends MetricOpportunity>({
  snapshot,
  used,
  coverage,
  opportunities,
  rules,
}: {
  snapshot: Pick<Snapshot, "jobs" | "metrics" | "seriesByMetricJob">
  used: Record<string, boolean | undefined>
  coverage: UsageCoverage
  opportunities: Array<T & { state: CutState; risk: Assessment }>
  rules: Rule[]
}): JobPlan<T>[] {
  const jobsOf = new Map(snapshot.metrics.map((item) => [item.metric, item.jobs ?? (item.topJob ? [item.topJob] : [])]))
  const plans = new Map<string | null, JobPlan<T>>()
  const planFor = (job: string | null, seriesCount: number) => {
    let plan = plans.get(job)
    if (!plan) {
      plan = { job, seriesCount, cuts: [], openSavings: 0, totalSavings: 0 }
      plans.set(job, plan)
    }
    return plan
  }
  const keepDrops = new Map<string, Set<string>>()

  for (const summary of snapshot.jobs) {
    const job = summary.job
    const plan = planFor(job, summary.seriesCount)
    const metrics = jobMetrics(snapshot, job)
    const active = rules.find((rule): rule is KeepMetricsRule => rule.kind === "keep_metrics" && rule.status === "active" && rule.selector.job === job)
    const proposed = rules.find((rule): rule is KeepMetricsRule => rule.kind === "keep_metrics" && rule.status === "proposed" && rule.selector.job === job)
    const keepList = coverage.rules && coverage.dashboards ? keepListCut(job, metrics, used, coverage, active, proposed) : active ? keepListCut(job, metrics, used, coverage, active) : null
    if (keepList) {
      plan.cuts.push(keepList)
      keepDrops.set(job, new Set(keepList.drop.map((item) => item.metric)))
    } else {
      const self = selfMetricsCut(job, metrics, used, coverage, rules)
      if (self) plan.cuts.push(self)
    }
  }

  // A metric already dropped whole needs no smaller cut: its trims and label drops show as covered otherwise.
  const droppedWhole = new Set(opportunities.filter((item) => item.rule.kind === "drop_metric" && item.state === "active").map((item) => item.metric))
  for (const item of opportunities) {
    if (item.rule.kind !== "drop_metric" && droppedWhole.has(item.metric)) continue
    const jobs = item.rule.job !== undefined ? [item.rule.job] : (jobsOf.get(item.metric) ?? [])
    const job = jobs.length === 1 ? jobs[0] : null
    const dropped = job === null ? undefined : keepDrops.get(job)
    // The keep-list decides which metrics of its job stay (its review lists them all), so whole-metric drops go there;
    // other cuts on a metric it drops change nothing once it is in.
    if (dropped && item.reason === "unused") continue
    if (dropped?.has(item.metric) && plans.get(job)?.cuts.some((cut) => cut.kind === "keep_list" && cut.state === "active")) continue
    const plan = planFor(job, job === null ? 0 : (snapshot.jobs.find((entry) => entry.job === job)?.seriesCount ?? 0))
    plan.cuts.push({
      id: item.id,
      kind: "opportunity",
      job,
      item,
      savedSeries: item.savedSeries,
      estimate: item.estimate,
      risk: item.risk,
      state: item.state,
    })
  }

  for (const plan of plans.values()) {
    const dropped = plan.job === null ? undefined : keepDrops.get(plan.job)
    // Stable order (cuts don't move when added): keep-list, self metrics, then the rest by saving.
    plan.cuts.sort((a, b) => kindRank(a) - kindRank(b) || b.savedSeries - a.savedSeries)
    // A keep-list already counts the metrics it drops.
    const counted = plan.cuts.filter((cut) => !(dropped && cut.kind === "opportunity" && dropped.has(cut.item.metric)))
    plan.openSavings = counted.filter((cut) => cut.state !== "active").reduce((sum, cut) => sum + cut.savedSeries, 0)
    plan.totalSavings = counted.reduce((sum, cut) => sum + cut.savedSeries, 0)
  }

  return Array.from(plans.values())
    .filter((plan) => plan.cuts.length > 0)
    .sort((a, b) => Number(a.job === null) - Number(b.job === null) || b.totalSavings - a.totalSavings || b.seriesCount - a.seriesCount)
}
const kindRank = (cut: PlanCut) => (cut.kind === "keep_list" ? 0 : cut.kind === "self_metrics" ? 1 : 2)
