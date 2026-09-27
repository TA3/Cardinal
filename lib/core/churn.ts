import type { JobMetricSeries } from "@/lib/prometheus/types"

// Churn: series that appeared and disappeared within a window. Backends that
// bill on series seen over time (Grafana Cloud, Mimir) count them, but an
// instant active-series count never shows them.

export const CHURN_WINDOWS = ["1h", "6h", "24h"] as const
export type ChurnWindow = (typeof CHURN_WINDOWS)[number]
export const DEFAULT_CHURN_WINDOW: ChurnWindow = "1h"

export const CHURN_WINDOW_LABEL: Record<ChurnWindow, string> = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours" }
export const CHURN_WINDOW_SECONDS: Record<ChurnWindow, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600 }

/** A pair seen/active ratio above this is flagged as high churn. */
export const HIGH_CHURN_RATIO = 1.5

export function isChurnWindow(value: unknown): value is ChurnWindow {
  return typeof value === "string" && (CHURN_WINDOWS as readonly string[]).includes(value)
}

export interface ChurnRow {
  job: string
  metric: string
  /** Series with at least one sample in the window. */
  seen: number
  /** Series active now. */
  active: number
  /** seen − active: series that existed in the window but are gone now. */
  churned: number
  /** seen / active; null when nothing of the pair is active any more. */
  ratio: number | null
  /** ratio above HIGH_CHURN_RATIO, or every series of the pair is gone. */
  high: boolean
}

function pairKey(job: string, metric: string) {
  return JSON.stringify([job, metric])
}

export function churnRatio(seen: number, active: number): number | null {
  if (active <= 0) return null
  return seen / active
}

export function isHighChurn(row: Pick<ChurnRow, "churned" | "ratio">) {
  return row.churned > 0 && (row.ratio === null || row.ratio > HIGH_CHURN_RATIO)
}

/**
 * Joins series seen over the window with series active now, per job and
 * metric. Active counts can come from a fresh query or a snapshot. Churn is
 * clamped at 0: an active count taken later than the window can exceed it.
 */
export function mergeChurn(seenRows: JobMetricSeries[], activeRows: JobMetricSeries[]): ChurnRow[] {
  const active = new Map<string, number>()
  for (const row of activeRows) {
    const key = pairKey(row.job, row.metric)
    active.set(key, (active.get(key) ?? 0) + row.seriesCount)
  }
  const seen = new Map<string, { job: string; metric: string; seen: number }>()
  for (const row of seenRows) {
    const key = pairKey(row.job, row.metric)
    const entry = seen.get(key) ?? { job: row.job, metric: row.metric, seen: 0 }
    entry.seen += row.seriesCount
    seen.set(key, entry)
  }
  const rows: ChurnRow[] = []
  for (const [key, entry] of seen) {
    const activeNow = active.get(key) ?? 0
    // A pair can be active but missing from `seen` only if the two were counted at different times.
    const seenCount = Math.max(entry.seen, activeNow)
    const churned = seenCount - activeNow
    const ratio = churnRatio(seenCount, activeNow)
    rows.push({ job: entry.job, metric: entry.metric, seen: seenCount, active: activeNow, churned, ratio, high: isHighChurn({ churned, ratio }) })
  }
  return rows
}

/** Active rows from a snapshot's per-job table (job "" = no job label). */
export function activeRowsFromTable(table: Record<string, Record<string, number>> | undefined): JobMetricSeries[] {
  if (!table) return []
  const rows: JobMetricSeries[] = []
  for (const metric of Object.keys(table)) {
    for (const job of Object.keys(table[metric])) rows.push({ job, metric, seriesCount: table[metric][job] })
  }
  return rows
}

/** Most churned series first; ties go to the higher ratio, then name. Pairs without churn are left out. */
export function rankChurn(rows: ChurnRow[], limit = Infinity): ChurnRow[] {
  const ratioOf = (row: ChurnRow) => row.ratio ?? Infinity
  return rows
    .filter((row) => row.churned > 0)
    .sort((a, b) => b.churned - a.churned || ratioOf(b) - ratioOf(a) || a.metric.localeCompare(b.metric) || a.job.localeCompare(b.job))
    .slice(0, limit)
}

export interface ChurnSummary {
  seen: number
  active: number
  churned: number
  /** Churned series as a percentage of active series (seen / active − 1). */
  churnPercent: number
  /** Pairs with any churn. */
  churningPairs: number
  /** Pairs flagged as high churn. */
  highPairs: number
}

export function summarizeChurn(rows: ChurnRow[]): ChurnSummary {
  let seen = 0
  let active = 0
  let churningPairs = 0
  let highPairs = 0
  for (const row of rows) {
    seen += row.seen
    active += row.active
    if (row.churned > 0) churningPairs += 1
    if (row.high) highPairs += 1
  }
  const churned = seen - active
  return { seen, active, churned, churnPercent: active > 0 ? (churned / active) * 100 : 0, churningPairs, highPairs }
}

export interface LabelChurnInput {
  label: string
  /** Distinct values seen over the window. */
  seen: number
  /** Distinct values now. */
  now: number
}

export interface LabelChurn extends LabelChurnInput {
  /** seen − now: values that came and went. */
  jump: number
  ratio: number | null
}

/**
 * Labels by how many distinct values came and went. The first label with a
 * jump is the likely churn driver (pod, container id, request id…).
 */
export function rankLabelDrivers(labels: LabelChurnInput[]): LabelChurn[] {
  return labels
    .filter((item) => item.label !== "__name__")
    .map((item) => ({ ...item, jump: Math.max(0, item.seen - item.now), ratio: churnRatio(item.seen, item.now) }))
    .sort((a, b) => b.jump - a.jump || (b.ratio ?? Infinity) - (a.ratio ?? Infinity) || a.label.localeCompare(b.label))
}

/** The label whose values churn the most, or undefined when no label changed. */
export function churnDriver(labels: LabelChurn[]): LabelChurn | undefined {
  const [top] = labels
  return top && top.jump > 0 ? top : undefined
}

export const CHURN_COST_NOTE =
  "Grafana Cloud bills on active series averaged over the month, and a series stays active for a while after its last sample, " +
  "so series that keep being replaced add to the bill even though an instant count doesn't show them. " +
  "This prices the churned series at your configured rate as a rough indication, not an invoice figure: " +
  "the real effect depends on how long each series lived and on your plan."

export interface ChurnCost {
  /** Monthly cost of `churned` series at the price, or null without a price. */
  monthly: number | null
  note: string
}

/** Rough monthly cost of churned series at `pricePer1kSeries` per 1,000 series per month. */
export function churnCost(churned: number, pricePer1kSeries: number | undefined): ChurnCost {
  const valid = typeof pricePer1kSeries === "number" && Number.isFinite(pricePer1kSeries) && pricePer1kSeries > 0
  const series = Number.isFinite(churned) ? Math.max(0, churned) : 0
  return { monthly: valid ? (series / 1000) * pricePer1kSeries : null, note: CHURN_COST_NOTE }
}
