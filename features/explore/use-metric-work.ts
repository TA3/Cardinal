import * as React from "react"

import { useStrictUsage } from "@/features/plan/use-cut-plan"
import { buildMetricWork, type MetricWork } from "@/lib/core/job-work"
import { useAppStore } from "@/lib/store/app-store"

const NONE: string[] = []

/**
 * One metric as the workbench shows it: what the plan does to it in the view
 * (one job's, or every job's when `job` is undefined) and whether anything
 * reads it. Undefined `metric` asks for nothing.
 */
export function useMetricWork(metric: string | undefined, job?: string): { item: MetricWork | undefined; used: boolean | undefined } {
  const snapshot = useAppStore((state) => state.snapshot)
  const rules = useAppStore((state) => state.rules)
  const kept = useAppStore((state) =>
    metric !== undefined && job !== undefined && Object.hasOwn(state.keptAsIs, job) ? state.keptAsIs[job].includes(metric) : false
  )
  const names = React.useMemo(() => (metric === undefined ? NONE : [metric]), [metric])
  const usage = useStrictUsage(names)

  const item = React.useMemo(() => {
    if (metric === undefined || !snapshot) return undefined
    const total = snapshot.metrics.find((entry) => entry.metric === metric)?.seriesCount ?? 0
    const perJob = snapshot.seriesByMetricJob?.[metric]
    const seriesCount = job === undefined ? total : perJob && Object.hasOwn(perJob, job) ? perJob[job] : total
    return buildMetricWork({ metric, seriesCount, rules, job, kept })
  }, [metric, job, snapshot, rules, kept])

  return { item, used: metric === undefined ? undefined : usage.used[metric] }
}
