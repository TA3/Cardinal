import * as React from "react"
import { toast } from "sonner"

import {
  useMetricOpportunities,
  useProposeOpportunity,
} from "@/features/overview/top-savings"
import { useUsageEvidence } from "@/features/rules/usage"
import {
  buildCutPlan,
  type KeepListCut,
  type PlanCut,
  type SelfMetricsCut,
  type UsageCoverage,
} from "@/lib/core/cut-plan"
import { jobLabel } from "@/lib/core/jobs"
import { activateOrCreate, type Rule, type RuleImpact } from "@/lib/core/rules"
import { snapshotImpact } from "@/lib/core/savings"
import type { Snapshot } from "@/lib/core/snapshot"
import { summarizeEvidence, type UsageEvidence } from "@/lib/core/usage-gate"
import { useAppStore } from "@/lib/store/app-store"

// Everything the Plan page needs: usage for every metric (keep-lists need the
// whole job), the opportunities the Overview already finds, and the cuts
// grouped by job. Adding a cut puts its rules straight into the plan.

function coverageOf(evidence: UsageEvidence | undefined): UsageCoverage {
  return {
    rules: Boolean(evidence && evidence.rules !== null),
    dashboards: Boolean(
      evidence?.dashboards?.dashboardsScanned || evidence?.cloud
    ),
  }
}

/**
 * Usage of `names` Cardinal can stand behind: true when something reads the
 * metric, false only when rules and dashboards were both checked, else
 * undefined (unknown).
 */
export function useStrictUsage(names: string[]) {
  const usage = useUsageEvidence(names)
  const coverage = React.useMemo(
    () => coverageOf(usage.byMetric[names[0]]),
    [usage.byMetric, names]
  )
  const used = React.useMemo(() => {
    const result: Record<string, boolean | undefined> = {}
    for (const metric of names) {
      const evidence = usage.byMetric[metric]
      const value = evidence ? summarizeEvidence(evidence).used : undefined
      result[metric] =
        coverage.rules && coverage.dashboards
          ? value
          : value === true
            ? true
            : undefined
    }
    return result
  }, [names, usage.byMetric, coverage])
  return { used, coverage, byMetric: usage.byMetric, isPending: usage.isPending }
}

export function useCutPlan(snapshot: Snapshot) {
  const rules = useAppStore((state) => state.rules)
  const names = React.useMemo(
    () => snapshot.metrics.map((item) => item.metric),
    [snapshot.metrics]
  )
  const usage = useStrictUsage(names)
  const { used, coverage } = usage
  const opportunities = useMetricOpportunities(snapshot)

  const jobs = React.useMemo(
    () =>
      usage.isPending
        ? []
        : buildCutPlan({
            snapshot,
            used,
            coverage,
            opportunities: opportunities.planned,
            rules,
          }),
    [usage.isPending, snapshot, used, coverage, opportunities.planned, rules]
  )
  return {
    jobs,
    coverage,
    used,
    loading: usage.isPending || opportunities.loading,
    impacts: opportunities.impacts,
  }
}

/** Puts the toast's Undo back to the rules before the add. */
function addedToast(title: string, description: string, before: Rule[]) {
  toast.success(title, {
    description,
    action: {
      label: "Undo",
      onClick: () => useAppStore.setState({ rules: before }),
    },
  })
}

/** Adds a job-wide cut (keep-list, the exporter's own metrics) as active rules, with an Undo toast. */
export function addJobCut(
  snapshot: Snapshot,
  cut: KeepListCut | SelfMetricsCut,
  keep?: string[]
) {
  const before = useAppStore.getState().rules
  if (cut.kind === "keep_list") {
    const kept = keep ?? cut.keep
    addKeepList(snapshot, cut, kept)
    addedToast(
      cut.rule ? "Keep-list updated" : "Keep-list added",
      `Job ${jobLabel(cut.job)} keeps ${kept.length} metric${kept.length === 1 ? "" : "s"}.`,
      before
    )
    return
  }
  addSelfMetrics(snapshot, cut)
  addedToast(
    "Added",
    `Job ${jobLabel(cut.job)} drops ${cut.metrics.length} Go and process metrics.`,
    before
  )
}

/** Takes a job's keep-list out of the plan, with an Undo toast. */
export function removeKeepList(cut: KeepListCut) {
  if (!cut.rule) return
  const before = useAppStore.getState().rules
  useAppStore.getState().removeRule(cut.rule.id)
  toast.success("Keep-list removed", {
    description: `Job ${jobLabel(cut.job)} keeps every metric again.`,
    action: {
      label: "Undo",
      onClick: () => useAppStore.setState({ rules: before }),
    },
  })
}

/** Adds a cut's rules as active rules; returns false when nothing changed. */
export function useAddCut(
  snapshot: Snapshot,
  impacts: Map<string, RuleImpact>
) {
  const propose = useProposeOpportunity(snapshot, impacts)
  return React.useCallback(
    async (cut: PlanCut, override?: { keep?: string[] }) => {
      if (cut.kind !== "opportunity") {
        addJobCut(snapshot, cut, override?.keep)
        return true
      }
      const before = useAppStore.getState().rules
      const added = await propose(cut.item, { activate: true })
      if (added) addedToast("Added", cutTitle(cut), before)
      else toast.info("Your plan already covers this")
      return added
    },
    [snapshot, propose]
  )
}

function addKeepList(snapshot: Snapshot, cut: KeepListCut, keep: string[]) {
  const input = {
    kind: "keep_metrics" as const,
    selector: { job: cut.job },
    metrics: keep,
    origin: "user" as const,
    rationale: keepRationale(cut, keep),
  }
  let rules = activateOrCreate(useAppStore.getState().rules, input)
  rules = rules.map((rule) =>
    rule.kind === "keep_metrics" &&
    rule.selector.job === cut.job &&
    rule.status === "active"
      ? { ...rule, impact: snapshotImpact(rule, snapshot) ?? undefined }
      : rule
  )
  useAppStore.setState({ rules })
}

function keepRationale(cut: KeepListCut, keep: string[]) {
  const suggested = new Set(cut.rule ? [] : cut.keep)
  const byHand = cut.rule
    ? 0
    : keep.filter((metric) => !suggested.has(metric)).length
  if (keep.length === 0)
    return `No dashboard or rule reads any metric of job ${jobLabel(cut.job)}: all dropped (up and scrape_* stay).`
  return `Keeps the ${keep.length} metrics of job ${jobLabel(cut.job)} that dashboards and rules read${byHand ? `, plus ${byHand} kept by hand` : ""}; drops the rest.`
}

function addSelfMetrics(snapshot: Snapshot, cut: SelfMetricsCut) {
  let rules = useAppStore.getState().rules
  for (const item of cut.metrics) {
    rules = activateOrCreate(rules, {
      kind: "drop_metric",
      selector: { metric: item.metric, job: cut.job },
      origin: "user",
      rationale: `The exporter's own runtime metric (job ${jobLabel(cut.job)}): it describes the exporter process, not what it monitors.`,
      impact: {
        seriesBefore: item.seriesCount,
        seriesAfter: 0,
        exact: true,
        mergesSeries: false,
        measuredAt: snapshot.capturedAt ?? new Date().toISOString(),
      },
    })
  }
  useAppStore.setState({ rules })
}

/** What a cut does, in plain words. */
export function cutTitle(cut: PlanCut) {
  if (cut.kind === "keep_list") {
    const others = `${cut.drop.length} other${cut.drop.length === 1 ? "" : "s"}`
    if (cut.keep.length === 0)
      return `Nothing reads this job: drop all ${cut.drop.length} metrics`
    // Once in the plan the list may hold metrics kept by hand: no longer just "in use".
    return `Keep ${cut.keep.length} metric${cut.keep.length === 1 ? "" : "s"}${cut.rule ? "" : " in use"}, drop ${others}`
  }
  if (cut.kind === "self_metrics")
    return `Drop the exporter's own Go and process metrics (${cut.metrics.length})`
  const { item } = cut
  const rule = item.rule
  if (rule.kind === "drop_metric") return `Drop ${item.metric}`
  if (rule.kind === "keep_buckets")
    return `Trim ${item.metric} to ${rule.buckets.length} buckets`
  if (item.reason === "aggregate")
    return `Sum ${item.metric} without ${rule.labels.join(", ")}`
  return `Remove ${rule.labels.join(", ")} from ${item.metric}`
}
