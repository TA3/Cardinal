import type { ChartConfig } from "@/components/ui/chart"
import type { MetricDrilldown, SnapshotResponse } from "@/lib/prometheus/types"

// ---------------------------------------------------------------------------
// Chart config
// ---------------------------------------------------------------------------

export const chartConfig: ChartConfig = {
  seriesCount: {
    label: "Series",
    color: "var(--chart-3)",
  },
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatNumber(value: number) {
  return value.toLocaleString()
}

export function formatPercent(value: number) {
  return `${value.toFixed(2)}%`
}

export function toChartRows(snapshot: SnapshotResponse | null) {
  if (!snapshot) return []
  return snapshot.topMetrics.slice(0, 10).map((item) => ({
    metric: item.metric,
    seriesCount: item.seriesCount,
  }))
}

// ---------------------------------------------------------------------------
// Savings helper
// ---------------------------------------------------------------------------

export interface Savings {
  savedSeries: number
  percent: number
  isEstimate: boolean
}

/**
 * Sums series counts for all selected metrics.
 * Uses snapshot.metrics (all metrics, not just top-N) for exact counts.
 */
export function computeExpectedSavings(
  dropMetrics: string[],
  snapshot: SnapshotResponse | null,
  selectedLabelsByMetric: Record<string, string[]>,
  metricDrilldownCache: Record<string, MetricDrilldown>
): Savings {
  const hasLabelSelections = Object.values(selectedLabelsByMetric).some(
    (labels) => labels.length > 0
  )

  if (!snapshot || (dropMetrics.length === 0 && !hasLabelSelections)) {
    return { savedSeries: 0, percent: 0, isEstimate: false }
  }
  const seriesMap = new Map<string, number>()
  for (const m of snapshot.metrics) seriesMap.set(m.metric, m.seriesCount)

  let savedSeries = 0
  let isEstimate = false
  for (const metric of dropMetrics) {
    const count = seriesMap.get(metric)
    if (count !== undefined) {
      savedSeries += count
    } else {
      isEstimate = true
    }
  }

  for (const [metric, labels] of Object.entries(selectedLabelsByMetric)) {
    if (labels.length === 0 || dropMetrics.includes(metric)) {
      continue
    }

    const metricSeriesCount = seriesMap.get(metric)
    const drilldown = metricDrilldownCache[metric]
    if (metricSeriesCount === undefined || !drilldown) {
      isEstimate = true
      continue
    }

    // Conservative heuristic: use the single strongest selected label as the
    // estimated reduction factor rather than summing overlapping labels.
    let strongestEstimatedReduction = 0

    for (const label of labels) {
      const labelInfo = drilldown.labels.find((item) => item.label === label)
      if (!labelInfo || labelInfo.cardinality <= 1) {
        isEstimate = true
        continue
      }

      const estimatedReduction =
        metricSeriesCount * (1 - 1 / labelInfo.cardinality)
      strongestEstimatedReduction = Math.max(
        strongestEstimatedReduction,
        estimatedReduction
      )
      isEstimate = true
    }

    savedSeries += Math.min(metricSeriesCount, strongestEstimatedReduction)
  }

  const percent =
    snapshot.totalSeries > 0
      ? Math.min(100, (savedSeries / snapshot.totalSeries) * 100)
      : 0
  return { savedSeries, percent, isEstimate }
}
