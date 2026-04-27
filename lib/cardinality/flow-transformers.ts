import type { MetricDrilldown, SnapshotResponse } from "@/lib/prometheus/types"
import type { CardinalityFlowEdge, CardinalityFlowNode } from "@/lib/cardinality/flow-model"

interface BuildCardinalityFlowGraphInput {
  snapshot: SnapshotResponse
  topMetricsPerJob: number
  expandedMetricIds: string[]
  metricPreviewCache: Record<string, MetricDrilldown>
  dropMetrics: string[]
  selectedLabelsByMetric: Record<string, string[]>
}

interface BuildCardinalityFlowGraphResult {
  nodes: CardinalityFlowNode[]
  edges: CardinalityFlowEdge[]
}

const JOB_X = 0
const METRIC_X = 320
const LABEL_X = 640

const MIN_JOB_BLOCK_HEIGHT = 180
const METRIC_ROW_HEIGHT = 100
const LABEL_ROW_HEIGHT = 90
const JOB_BLOCK_GAP = 40

function toPercent(value: number) {
  return `${value.toFixed(2)}%`
}

export function buildCardinalityFlowGraph({
  snapshot,
  topMetricsPerJob,
  expandedMetricIds,
  metricPreviewCache,
  dropMetrics,
  selectedLabelsByMetric,
}: BuildCardinalityFlowGraphInput): BuildCardinalityFlowGraphResult {
  const nodes: CardinalityFlowNode[] = []
  const edges: CardinalityFlowEdge[] = []

  const allMetricsByTopJob = snapshot.metrics.reduce(
    (acc, metric) => {
      const key = metric.topJob ?? "unattributed"
      if (!acc.has(key)) {
        acc.set(key, [])
      }
      acc.get(key)?.push(metric)
      return acc
    },
    new Map<string, SnapshotResponse["metrics"]>()
  )

  const sortedJobs = [...snapshot.jobs].sort((a, b) => b.seriesCount - a.seriesCount)

  let yCursor = 0

  for (const job of sortedJobs) {
    const jobNodeId = `job:${job.job}`
    const metricsForJob = [...(allMetricsByTopJob.get(job.job) ?? [])]
      .sort((a, b) => b.seriesCount - a.seriesCount)
      .slice(0, topMetricsPerJob)

    const metricAreaHeight = Math.max(MIN_JOB_BLOCK_HEIGHT, metricsForJob.length * METRIC_ROW_HEIGHT)
    const jobY = yCursor + metricAreaHeight / 2 - 52

    nodes.push({
      id: jobNodeId,
      position: { x: JOB_X, y: jobY },
      type: "cardinality",
      draggable: true,
      data: {
        kind: "job",
        id: jobNodeId,
        title: job.job,
        subtitle: `${job.seriesCount.toLocaleString()} series · ${toPercent(job.percentageOfTotal)}`,
        jobName: job.job,
        percentage: job.percentageOfTotal,
      },
    })

    metricsForJob.forEach((metric, metricIndex) => {
      const metricNodeId = `metric:${metric.metric}`
      const metricY = yCursor + metricIndex * METRIC_ROW_HEIGHT
      const labelsExpanded = expandedMetricIds.includes(metric.metric)
      const metricPreview = metricPreviewCache[metric.metric]
      const metricLabels = metricPreview?.labels.slice(0, 10) ?? []
      const selectedLabels = selectedLabelsByMetric[metric.metric] ?? []

      nodes.push({
        id: metricNodeId,
        position: { x: METRIC_X, y: metricY },
        type: "cardinality",
        draggable: true,
        data: {
          kind: "metric",
          id: metricNodeId,
          title: metric.metric,
          subtitle: `${metric.seriesCount.toLocaleString()} series · ${toPercent(metric.percentageOfTotal)}`,
          metricName: metric.metric,
          jobName: job.job,
          percentage: metric.percentageOfTotal,
          isDropped: dropMetrics.includes(metric.metric),
          canExpandLabels: true,
          labelsExpanded,
        },
      })

      edges.push({
        id: `edge:${jobNodeId}->${metricNodeId}`,
        source: jobNodeId,
        target: metricNodeId,
        animated: false,
      })

      if (!labelsExpanded) {
        return
      }

      metricLabels.forEach((label, labelIndex) => {
        const labelPct = metricPreview && metricPreview.seriesCount > 0
          ? (label.cardinality / metricPreview.seriesCount) * 100
          : 0

        const labelNodeId = `label:${metric.metric}:${label.label}`
        nodes.push({
          id: labelNodeId,
          position: {
            x: LABEL_X,
            y: metricY + labelIndex * LABEL_ROW_HEIGHT,
          },
          type: "cardinality",
          draggable: true,
          data: {
            kind: "label",
            id: labelNodeId,
            title: label.label,
            subtitle: `${label.cardinality.toLocaleString()} cardinality · ${labelPct.toFixed(1)}%`,
            metricName: metric.metric,
            labelName: label.label,
            percentage: labelPct,
            isLabelDropped: selectedLabels.includes(label.label),
          },
        })

        edges.push({
          id: `edge:${metricNodeId}->${labelNodeId}`,
          source: metricNodeId,
          target: labelNodeId,
          animated: false,
        })
      })
    })

    yCursor += metricAreaHeight + JOB_BLOCK_GAP
  }

  return { nodes, edges }
}
