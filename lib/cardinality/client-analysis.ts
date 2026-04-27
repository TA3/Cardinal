"use client"

import { runWithConcurrency } from "@/lib/cardinality/concurrency"
import {
  fetchJobAggregation,
  fetchLabels,
  fetchMetricNames,
  fetchMetricSeriesCount,
  fetchMetricSeriesForDrilldown,
} from "@/lib/prometheus/client"
import {
  JobDrilldownResponse,
  JobSummary,
  MetricDrilldown,
  MetricSummary,
  PrometheusConnectionInput,
  SnapshotResponse,
} from "@/lib/prometheus/types"

interface ProgressOptions {
  onProgress?: (message: string) => void
}

function toPercent(part: number, total: number) {
  if (total <= 0) {
    return 0
  }
  return Number(((part / total) * 100).toFixed(2))
}

export async function buildSnapshotClient(
  connection: PrometheusConnectionInput,
  topN = 20,
  concurrency = 10,
  options?: ProgressOptions
): Promise<SnapshotResponse> {
  options?.onProgress?.("Connecting to Prometheus")

  const [metricNames, labels, jobAggregation] = await Promise.all([
    fetchMetricNames(connection),
    fetchLabels(connection),
    fetchJobAggregation(connection),
  ])

  options?.onProgress?.(
    `Fetched ${metricNames.length.toLocaleString()} metrics and ${labels.length.toLocaleString()} labels`
  )

  const failedMetrics: string[] = []
  let processedMetrics = 0

  const metricCounts = await runWithConcurrency(
    metricNames,
    async (metricName) => {
      try {
        const row = await fetchMetricSeriesCount(connection, metricName)
        processedMetrics += 1
        if (
          processedMetrics === metricNames.length ||
          processedMetrics % Math.max(1, Math.floor(metricNames.length / 10)) === 0
        ) {
          options?.onProgress?.(
            `Metric query progress: ${processedMetrics.toLocaleString()}/${metricNames.length.toLocaleString()}`
          )
        }
        return row
      } catch {
        failedMetrics.push(metricName)
        processedMetrics += 1
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

  options?.onProgress?.("Snapshot analysis complete")

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

export async function buildJobDrilldownClient(
  connection: PrometheusConnectionInput,
  job: string,
  options?: ProgressOptions
): Promise<JobDrilldownResponse> {
  options?.onProgress?.(`Loading metrics for job: ${job}`)

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

export async function buildMetricDrilldownClient(
  connection: PrometheusConnectionInput,
  metric: string,
  options?: ProgressOptions
): Promise<MetricDrilldown> {
  options?.onProgress?.(`Loading active series for metric: ${metric}`)
  const result = await fetchMetricSeriesForDrilldown(connection, metric)
  options?.onProgress?.(
    `Computed label cardinality for ${result.labels.length.toLocaleString()} labels`
  )
  return result
}
