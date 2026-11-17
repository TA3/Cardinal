import * as React from "react"

import { useStrictUsage } from "@/features/plan/use-cut-plan"
import { useJobDrilldown } from "@/hooks/use-cardinality"
import { jobKeepListCut, jobSelfMetricsCut } from "@/lib/core/cut-plan"
import { buildJobWork } from "@/lib/core/job-work"
import { jobMetrics, type JobMetric } from "@/lib/core/keep-list"
import type { Snapshot } from "@/lib/core/snapshot"
import { useAppStore } from "@/lib/store/app-store"

const NONE: string[] = []

/**
 * Everything the job workbench shows: each metric of the job with what the
 * plan does to it there, usage Cardinal can stand behind, and the job-wide
 * cuts (keep-list, the exporter's own metrics).
 */
export function useJobWork(job: string, snapshot: Snapshot) {
  const fromSnapshot = React.useMemo(() => jobMetrics(snapshot, job), [snapshot, job])
  // Snapshots from before per-job counts: ask the backend instead.
  const drilldown = useJobDrilldown(fromSnapshot.length ? undefined : job)
  const metrics = React.useMemo<JobMetric[]>(
    () =>
      fromSnapshot.length
        ? fromSnapshot
        : (drilldown.data?.metrics ?? []).map((row) => ({ metric: row.metric, seriesCount: row.seriesCount })),
    [fromSnapshot, drilldown.data]
  )
  const rules = useAppStore((state) => state.rules)
  const kept = useAppStore((state) => (Object.hasOwn(state.keptAsIs, job) ? state.keptAsIs[job] : NONE))
  const names = React.useMemo(() => metrics.map((item) => item.metric), [metrics])
  const usage = useStrictUsage(names)

  const work = React.useMemo(() => buildJobWork({ job, metrics, rules, kept }), [job, metrics, rules, kept])
  const keepList = React.useMemo(
    () => (metrics.length ? jobKeepListCut(job, metrics, usage.used, usage.coverage, rules) : null),
    [job, metrics, usage.used, usage.coverage, rules]
  )
  // Only the exporter metrics nothing drops yet (a keep-list may drop them already).
  const selfMetrics = React.useMemo(() => {
    const cut = jobSelfMetricsCut(job, metrics, usage.used, usage.coverage, rules)
    if (!cut) return null
    const gone = new Set(work.metrics.filter((item) => item.state === "dropped").map((item) => item.metric))
    const left = cut.metrics.filter((item) => !gone.has(item.metric))
    if (left.length === 0) return null
    return { ...cut, metrics: left, savedSeries: left.reduce((sum, item) => sum + item.seriesCount, 0) }
  }, [job, metrics, usage.used, usage.coverage, rules, work.metrics])

  return {
    work,
    used: usage.used,
    byMetric: usage.byMetric,
    keepList,
    selfMetrics,
    loading: !fromSnapshot.length && drilldown.isLoading,
    error: fromSnapshot.length ? null : drilldown.error,
  }
}
