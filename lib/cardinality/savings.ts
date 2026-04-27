import { SnapshotResponse } from "@/lib/prometheus/types"

export interface ExpectedSavings {
  savedSeries: number
  totalSeries: number
  percent: number
  /** True when at least one selected metric was not in snapshot data (unknown count) */
  isEstimate: boolean
}

/**
 * Compute the expected savings from dropping the given metrics.
 * Uses the snapshot's metrics array to look up per-metric series counts.
 * Only metrics present in the snapshot have a known count; others are marked
 * as estimates so the UI can show a "~" prefix.
 */
export function computeExpectedSavings(
  dropMetrics: string[],
  snapshot: SnapshotResponse | null
): ExpectedSavings {
  if (!snapshot || dropMetrics.length === 0) {
    return { savedSeries: 0, totalSeries: snapshot?.totalSeries ?? 0, percent: 0, isEstimate: false }
  }

  // Build a lookup from all snapshot metrics (metrics array contains all, topMetrics is top-N subset)
  const seriesMap = new Map<string, number>()
  for (const m of snapshot.metrics) {
    seriesMap.set(m.metric, m.seriesCount)
  }
  // Also include topMetrics in case metrics array is a subset
  for (const m of snapshot.topMetrics) {
    if (!seriesMap.has(m.metric)) {
      seriesMap.set(m.metric, m.seriesCount)
    }
  }

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

  const totalSeries = snapshot.totalSeries
  const percent = totalSeries > 0 ? (savedSeries / totalSeries) * 100 : 0

  return { savedSeries, totalSeries, percent, isEstimate }
}
