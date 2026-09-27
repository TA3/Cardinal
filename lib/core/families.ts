import type { SnapshotResponse } from "@/lib/prometheus/types"

// Histogram (and summary) families: `x_bucket`, `x_sum`, `x_count` share base `x`.

export type HistogramPart = "bucket" | "sum" | "count"

const HISTOGRAM_PARTS: HistogramPart[] = ["bucket", "sum", "count"]

/** Splits `x_bucket` / `x_sum` / `x_count` into base `x` and the part; other names have part null. */
export function histogramFamily(metric: string): { base: string; part: HistogramPart | null } {
  for (const part of HISTOGRAM_PARTS) {
    const suffix = `_${part}`
    if (metric.length > suffix.length && metric.endsWith(suffix)) {
      return { base: metric.slice(0, -suffix.length), part }
    }
  }
  return { base: metric, part: null }
}

/** Metrics of the family in the snapshot: `base` (summary quantiles), `_bucket`, `_sum`, `_count`. */
export function familyMembers(base: string, snapshot: Pick<SnapshotResponse, "metrics"> | null): string[] {
  if (!snapshot) return []
  const names = new Set(snapshot.metrics.map((item) => item.metric))
  return [base, ...HISTOGRAM_PARTS.map((part) => `${base}_${part}`)].filter((name) => names.has(name))
}
