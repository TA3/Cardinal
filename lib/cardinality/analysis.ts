import { runWithConcurrency } from "@/lib/cardinality/concurrency"
import {
  fetchJobAggregation,
  fetchLabels,
  fetchMetricNames,
  fetchMetricSeriesCount,
} from "@/lib/prometheus/client"
import {
  JobDrilldownResponse,
  JobSummary,
  MetricSummary,
  PrometheusConnectionInput,
  SnapshotResponse,
} from "@/lib/prometheus/types"

function toPercent(part: number, total: number) {
  if (total <= 0) {
    return 0
  }
  return Number(((part / total) * 100).toFixed(2))
}

export async function buildSnapshot(
  connection: PrometheusConnectionInput,
  topN = 20,
  concurrency = 10
): Promise<SnapshotResponse> {
  const [metricNames, labels, jobAggregation] = await Promise.all([
    fetchMetricNames(connection),
    fetchLabels(connection),
    fetchJobAggregation(connection),
  ])

  const failedMetrics: string[] = []

  const metricCounts = await runWithConcurrency(
    metricNames,
    async (metricName) => {
      try {
        return await fetchMetricSeriesCount(connection, metricName)
      } catch {
        failedMetrics.push(metricName)
        return { metric: metricName, seriesCount: 0 }
      }
    },
    concurrency
  )

  const totalSeries = metricCounts.reduce((sum, row) => sum + row.seriesCount, 0)

  const topJobByMetric = new Map<string, { job: string; seriesCount: number }>()
  for (const row of jobAggregation) {
    const current = topJobByMetric.get(row.metric)
    if (!current || row.seriesCount > current.seriesCount) {
      topJobByMetric.set(row.metric, {
        job: row.job,
        seriesCount: row.seriesCount,
      })
    }
  }

  const metrics: MetricSummary[] = metricCounts
    .map((row) => ({
      metric: row.metric,
      seriesCount: row.seriesCount,
      percentageOfTotal: toPercent(row.seriesCount, totalSeries),
      topJob: topJobByMetric.get(row.metric)?.job,
    }))
    .sort((a, b) => b.seriesCount - a.seriesCount)

  const jobsMap = new Map<string, { seriesCount: number; metrics: Set<string> }>()

  for (const row of jobAggregation) {
    if (!jobsMap.has(row.job)) {
      jobsMap.set(row.job, { seriesCount: 0, metrics: new Set() })
    }
    const current = jobsMap.get(row.job)
    if (!current) {
      continue
    }
    current.seriesCount += row.seriesCount
    current.metrics.add(row.metric)
  }

  const jobs: JobSummary[] = Array.from(jobsMap.entries())
    .map(([job, value]) => ({
      job,
      seriesCount: value.seriesCount,
      percentageOfTotal: toPercent(value.seriesCount, totalSeries),
      metricCount: value.metrics.size,
    }))
    .sort((a, b) => b.seriesCount - a.seriesCount)

  return {
    totalSeries,
    metricCount: metricNames.length,
    labelCount: labels.length,
    topN,
    topMetrics: metrics.slice(0, topN),
    metrics,
    jobs,
    failedMetrics,
  }
}

export async function buildJobDrilldown(
  connection: PrometheusConnectionInput,
  job: string
): Promise<JobDrilldownResponse> {
  const jobAggregation = await fetchJobAggregation(connection)

  const metricsForJob = jobAggregation
    .filter((row) => row.job === job)
    .sort((a, b) => b.seriesCount - a.seriesCount)

  const totalSeries = metricsForJob.reduce((sum, row) => sum + row.seriesCount, 0)

  return {
    job,
    totalSeries,
    metrics: metricsForJob.map((row) => ({
      job: row.job,
      metric: row.metric,
      seriesCount: row.seriesCount,
      percentageOfTotal: toPercent(row.seriesCount, totalSeries),
    })),
  }
}
