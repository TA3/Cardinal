import { histogramFamily } from "@/lib/core/families"
import { isKept, sortUnique } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"

// Keep-lists: for big collectors (node, windows, SNMP, kube-state-metrics)
// it is safer and shorter to say what stays than what goes. Everything a job
// exports that no dashboard or rule reads is dropped, and so is whatever a
// new exporter version adds, until someone uses it.

/** An exporter's own runtime metrics: rarely on a dashboard, on every target. */
export const SELF_METRIC = /^(?:go|process|promhttp)_/

export interface JobMetric {
  metric: string
  seriesCount: number
}

/** Every metric of `job` with its series count, largest first. Empty for legacy snapshots without per-job counts. */
export function jobMetrics(snapshot: Pick<Snapshot, "seriesByMetricJob">, job: string): JobMetric[] {
  const table = snapshot.seriesByMetricJob
  if (!table) return []
  const rows: JobMetric[] = []
  for (const metric of Object.keys(table)) {
    const perJob = table[metric]
    if (Object.hasOwn(perJob, job) && perJob[job] > 0) rows.push({ metric, seriesCount: perJob[job] })
  }
  return rows.sort((a, b) => b.seriesCount - a.seriesCount || a.metric.localeCompare(b.metric))
}

/** The metrics of `job` a keep-list keeping `keep` drops. */
export function keepListDrops(snapshot: Pick<Snapshot, "seriesByMetricJob">, job: string, keep: readonly string[]): JobMetric[] {
  return jobMetrics(snapshot, job).filter((item) => !isKept(item.metric, keep))
}

/**
 * The keep-list Cardinal suggests for a job: every metric something uses,
 * plus every metric nothing could be checked for. A histogram family stays
 * whole when any part of it is used, so `_sum`/`_count` panels keep working
 * next to a `histogram_quantile` over `_bucket`.
 */
export function suggestKeepList(metrics: JobMetric[], used: Record<string, boolean | undefined>) {
  const usedFamilies = new Set(metrics.filter((item) => used[item.metric] === true).map((item) => histogramFamily(item.metric).base))
  const keep = metrics.filter((item) => used[item.metric] !== false || usedFamilies.has(histogramFamily(item.metric).base)).map((item) => item.metric)
  const kept = new Set(keep)
  const drop = metrics.filter((item) => !kept.has(item.metric) && !isKept(item.metric, []))
  return {
    keep: sortUnique(keep),
    drop,
    savedSeries: drop.reduce((sum, item) => sum + item.seriesCount, 0),
    selfMetrics: drop.filter((item) => SELF_METRIC.test(item.metric)).length,
  }
}
