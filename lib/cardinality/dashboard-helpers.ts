import type { ChartConfig } from "@/components/ui/chart"
import type { SnapshotResponse } from "@/lib/prometheus/types"

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

/** Returns a text-colour class based on the metric's share of total series. */
export function seriesColor(pct: number) {
  if (pct >= 5) return "text-red-500"
  if (pct >= 1) return "text-amber-500"
  return ""
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
  snapshot: SnapshotResponse | null
): Savings {
  if (!snapshot || dropMetrics.length === 0) {
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
  const percent =
    snapshot.totalSeries > 0
      ? Math.min(100, (savedSeries / snapshot.totalSeries) * 100)
      : 0
  return { savedSeries, percent, isEstimate }
}
