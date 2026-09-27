import type {
  JobDrilldownResponse,
  JobMetricSeries,
  JobSummary,
  MetricSummary,
  SnapshotResponse,
} from "@/lib/prometheus/types"

/**
 * A snapshot as built by Cardinal. `labelCount` is null when the label-name
 * lookup failed (it only feeds a stat). `seriesByMetricJob` holds the exact
 * series count per metric and job (job "" = no job label); snapshots persisted
 * by older versions lack it.
 */
export interface Snapshot extends Omit<SnapshotResponse, "labelCount"> {
  labelCount: number | null
  seriesByMetricJob?: Record<string, Record<string, number>>
  /** Host (and port) of the backend the snapshot came from. Absent on older snapshots. */
  host?: string
  /** "query": one `count by (job, __name__)`; "per-job": fallback after that hit a query limit. */
  method?: "query" | "per-job"
  /** Per-job snapshots only: jobs left out because every way of counting them failed. */
  skippedJobs?: string[]
  /** Per-job snapshots only: jobs counted with Mimir's cardinality API, which lists at most 500 metrics each. */
  truncatedJobs?: string[]
}

export function toPercent(part: number, total: number) {
  if (total <= 0) return 0
  return Number(((part / total) * 100).toFixed(2))
}

/**
 * Builds the snapshot from `count by (job, __name__)` rows. The rows partition
 * every series, so metric and job totals are exact without per-metric queries.
 */
export function buildSnapshotFromRows(
  rows: JobMetricSeries[],
  labelCount: number | null,
  topN: number
): Snapshot {
  const byMetric = new Map<string, { seriesCount: number; jobs: Array<{ job: string; seriesCount: number }> }>()
  const byJob = new Map<string, { seriesCount: number; metrics: Set<string> }>()
  // Null prototypes: metric and job names like "__proto__" are valid.
  const seriesByMetricJob: Record<string, Record<string, number>> = Object.create(null)
  let totalSeries = 0

  for (const row of rows) {
    totalSeries += row.seriesCount

    const metric = byMetric.get(row.metric) ?? { seriesCount: 0, jobs: [] }
    metric.seriesCount += row.seriesCount
    metric.jobs.push({ job: row.job, seriesCount: row.seriesCount })
    byMetric.set(row.metric, metric)

    const job = byJob.get(row.job) ?? { seriesCount: 0, metrics: new Set<string>() }
    job.seriesCount += row.seriesCount
    job.metrics.add(row.metric)
    byJob.set(row.job, job)

    const perJob = (seriesByMetricJob[row.metric] ??= Object.create(null) as Record<string, number>)
    perJob[row.job] = (perJob[row.job] ?? 0) + row.seriesCount
  }

  const metrics: MetricSummary[] = Array.from(byMetric.entries())
    .map(([metric, value]) => {
      const jobs = [...value.jobs].sort((a, b) => b.seriesCount - a.seriesCount)
      return {
        metric,
        seriesCount: value.seriesCount,
        percentageOfTotal: toPercent(value.seriesCount, totalSeries),
        topJob: jobs[0]?.job,
        jobs: jobs.map((item) => item.job),
      }
    })
    .sort((a, b) => b.seriesCount - a.seriesCount)

  const jobs: JobSummary[] = Array.from(byJob.entries())
    .map(([job, value]) => ({
      job,
      seriesCount: value.seriesCount,
      percentageOfTotal: toPercent(value.seriesCount, totalSeries),
      metricCount: value.metrics.size,
    }))
    .sort((a, b) => b.seriesCount - a.seriesCount)

  return {
    totalSeries,
    metricCount: metrics.length,
    labelCount,
    topN,
    topMetrics: metrics.slice(0, topN),
    metrics,
    jobs,
    failedMetrics: [],
    capturedAt: new Date().toISOString(),
    seriesByMetricJob,
  }
}

export function buildJobDrilldownFromRows(rows: JobMetricSeries[], job: string): JobDrilldownResponse {
  const metricsForJob = rows.filter((row) => row.job === job).sort((a, b) => b.seriesCount - a.seriesCount)
  const totalSeries = metricsForJob.reduce((sum, row) => sum + row.seriesCount, 0)
  return {
    job,
    totalSeries,
    metrics: metricsForJob.map((row) => ({
      ...row,
      percentageOfTotal: toPercent(row.seriesCount, totalSeries),
    })),
  }
}

export function jobsByMetric(snapshot: Pick<SnapshotResponse, "metrics">) {
  return Object.fromEntries(snapshot.metrics.map((metric) => [metric.metric, metric.jobs ?? []]))
}

/**
 * Exact series count for a metric and job from the snapshot: the metric total
 * when `job` is undefined. Undefined when the snapshot cannot tell (legacy
 * snapshots have no per-job counts).
 */
export function snapshotSeries(
  snapshot: Pick<Snapshot, "metrics" | "seriesByMetricJob">,
  metric: string,
  job?: string
): number | undefined {
  if (job === undefined) return snapshot.metrics.find((item) => item.metric === metric)?.seriesCount ?? 0
  const table = snapshot.seriesByMetricJob
  if (!table) return undefined
  const perJob = Object.hasOwn(table, metric) ? table[metric] : undefined
  return perJob && Object.hasOwn(perJob, job) ? perJob[job] : 0
}
