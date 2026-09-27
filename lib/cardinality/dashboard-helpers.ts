export { familyMembers, histogramFamily, type HistogramPart } from "@/lib/core/families"
export { computeExpectedSavings, formatDelta, snapshotImpact, type Savings, type SnapshotLike } from "@/lib/core/savings"

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatNumber(value: number) {
  return value.toLocaleString()
}
