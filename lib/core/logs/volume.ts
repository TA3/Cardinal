// Logs volume by label value over a period and against the period before it:
// ranking, shares, growth and the top growers, plus the chart's top series.
// Pure; the Volume page fetches index/volume and index/volume_range.

import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogsRange } from "@/lib/core/logs/types"

/** Growth under this percentage either way reads as flat. */
export const FLAT_PERCENT = 5
/** A grower must grow at least this much, in percent (new values always qualify)… */
export const GROWER_MIN_PERCENT = 10
/** …and by at least this share of the current total, so tiny values don't crowd the list. */
export const GROWER_MIN_SHARE = 0.005

export interface Period {
  /** Unix ms. */
  start: number
  end: number
}

export interface VolumePeriods {
  current: Period
  previous: Period
}

/**
 * The current range and the one before it, with the end rounded down to
 * `alignSeconds` so cached queries line up across refetches.
 */
export function volumePeriods(range: LogsRange, now: number, alignSeconds = 60): VolumePeriods {
  const align = Math.max(1, alignSeconds) * 1000
  const end = Math.floor(now / align) * align
  const length = LOGS_RANGE_SECONDS[range] * 1000
  return { current: { start: end - length, end }, previous: { start: end - 2 * length, end: end - length } }
}

export interface ValueBytes {
  /** The label value; "" for streams without the label. */
  value: string
  bytes: number
}

/** Bytes per value of `label` from index/volume rows, merged (rows without the label go to ""). */
export function bytesByValue(rows: Array<{ labels: Record<string, string>; bytes: number }>, label: string): ValueBytes[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const value = Object.hasOwn(row.labels, label) ? row.labels[label] : ""
    totals.set(value, (totals.get(value) ?? 0) + (Number.isFinite(row.bytes) ? Math.max(0, row.bytes) : 0))
  }
  return Array.from(totals, ([value, bytes]) => ({ value, bytes }))
}

export type VolumeTrend = "new" | "up" | "flat" | "down" | "gone" | "unknown"

export interface VolumeRow {
  value: string
  bytes: number
  /** Bytes in the previous period; null when there is no previous period to compare with. */
  previousBytes: number | null
  /** Share of the current total, 0–100. */
  share: number
  /** bytes − previousBytes, null without a previous period. */
  delta: number | null
  /** Percent change, null when new or without a previous period. */
  growth: number | null
  trend: VolumeTrend
  /** Grew enough to list among the top growers. */
  grower: boolean
}

/** Percent change from `before` to `after`; null when `before` is 0. */
export function growthPercent(before: number, after: number): number | null {
  if (!(before > 0) || !Number.isFinite(after)) return null
  return ((after - before) / before) * 100
}

function trendOf(before: number | null, after: number): VolumeTrend {
  if (before === null) return "unknown"
  if (before <= 0 && after <= 0) return "flat"
  if (before <= 0) return "new"
  if (after <= 0) return "gone"
  const growth = growthPercent(before, after)!
  if (growth >= FLAT_PERCENT) return "up"
  if (growth <= -FLAT_PERCENT) return "down"
  return "flat"
}

/**
 * Current values with their share and change against the previous period
 * (null previous = nothing to compare with, e.g. before the data starts).
 * Values only in the previous period come last as "gone". Sorted by bytes.
 */
export function compareVolumes(current: ValueBytes[], previous: ValueBytes[] | null): VolumeRow[] {
  const total = current.reduce((sum, item) => sum + item.bytes, 0)
  const before = new Map(previous?.map((item) => [item.value, item.bytes]) ?? [])
  const rows: VolumeRow[] = current.map((item) => {
    const previousBytes = previous ? (before.get(item.value) ?? 0) : null
    const delta = previousBytes === null ? null : item.bytes - previousBytes
    const growth = previousBytes === null ? null : growthPercent(previousBytes, item.bytes)
    const trend = trendOf(previousBytes, item.bytes)
    const bigEnough = delta !== null && delta > 0 && total > 0 && delta / total >= GROWER_MIN_SHARE
    const grower = bigEnough && (trend === "new" || (growth !== null && growth >= GROWER_MIN_PERCENT))
    return { value: item.value, bytes: item.bytes, previousBytes, share: total > 0 ? (item.bytes / total) * 100 : 0, delta, growth, trend, grower }
  })
  const seen = new Set(current.map((item) => item.value))
  const gone: VolumeRow[] = (previous ?? [])
    .filter((item) => !seen.has(item.value) && item.bytes > 0)
    .map((item) => ({ value: item.value, bytes: 0, previousBytes: item.bytes, share: 0, delta: -item.bytes, growth: -100, trend: "gone", grower: false }))
  rows.sort((a, b) => b.bytes - a.bytes || a.value.localeCompare(b.value))
  gone.sort((a, b) => (b.previousBytes ?? 0) - (a.previousBytes ?? 0) || a.value.localeCompare(b.value))
  return [...rows, ...gone]
}

/** The rows that grew most in bytes, largest growth first. */
export function topGrowers(rows: VolumeRow[], limit = 5): VolumeRow[] {
  return rows
    .filter((row) => row.grower)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.value.localeCompare(b.value))
    .slice(0, limit)
}

export interface VolumeTotals {
  bytes: number
  previousBytes: number | null
  delta: number | null
  growth: number | null
}

export function volumeTotals(current: ValueBytes[], previous: ValueBytes[] | null): VolumeTotals {
  const bytes = current.reduce((sum, item) => sum + item.bytes, 0)
  if (!previous) return { bytes, previousBytes: null, delta: null, growth: null }
  const previousBytes = previous.reduce((sum, item) => sum + item.bytes, 0)
  // A previous period without data isn't a comparison; before the data starts everything is "new".
  if (previousBytes <= 0) return { bytes, previousBytes: null, delta: null, growth: null }
  return { bytes, previousBytes, delta: bytes - previousBytes, growth: growthPercent(previousBytes, bytes) }
}

/** Bytes per day at the rate of `bytes` over `range`. */
export function perDay(bytes: number, range: LogsRange) {
  return (bytes / LOGS_RANGE_SECONDS[range]) * 86400
}

/** "+12%", "−3.4%", "new", "0%". */
export function formatGrowth(growth: number | null, trend?: VolumeTrend) {
  if (trend === "new") return "new"
  if (trend === "gone") return "gone"
  if (growth === null || !Number.isFinite(growth)) return "—"
  const abs = Math.abs(growth)
  const text = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)
  if (Number(text.replace(/,/g, "")) === 0) return "0%"
  return `${growth > 0 ? "+" : "−"}${text}%`
}

export interface SeriesPoint {
  t: number
  value: number
}

export interface TopSeries {
  /** Label values drawn, largest first. */
  keys: string[]
  /** One point per timestamp with a value per key (missing = 0). */
  points: Array<{ t: number; values: Record<string, number> }>
}

/**
 * The `limit` largest values of `label` over time, from volume_range series.
 * Points at or after `dropFrom` (the bucket still being written) and before
 * `dropBefore` (the first bucket, which also counts chunks that started
 * before the range) are left out: the index overcounts both.
 */
export function topVolumeSeries(
  series: Array<{ labels: Record<string, string>; points: SeriesPoint[] }>,
  label: string,
  { limit = 5, dropFrom, dropBefore }: { limit?: number; dropFrom?: number; dropBefore?: number } = {}
): TopSeries {
  const byValue = new Map<string, Map<number, number>>()
  for (const item of series) {
    const value = Object.hasOwn(item.labels, label) ? item.labels[label] : ""
    const points = byValue.get(value) ?? new Map<number, number>()
    for (const point of item.points) {
      if ((dropFrom !== undefined && point.t >= dropFrom) || (dropBefore !== undefined && point.t < dropBefore)) continue
      points.set(point.t, (points.get(point.t) ?? 0) + point.value)
    }
    byValue.set(value, points)
  }
  const totals = Array.from(byValue, ([value, points]) => ({ value, total: Array.from(points.values()).reduce((a, b) => a + b, 0) }))
  const keys = totals
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((item) => item.value)
  const times = new Set<number>()
  for (const key of keys) for (const t of byValue.get(key)!.keys()) times.add(t)
  const points = Array.from(times)
    .sort((a, b) => a - b)
    .map((t) => ({ t, values: Object.fromEntries(keys.map((key) => [key, byValue.get(key)!.get(t) ?? 0])) }))
  return { keys, points }
}

/** Stream counts now vs the previous period: new streams is the growth, never negative. */
export function streamChange(now: number, before: number | null) {
  if (before === null || !(before > 0)) return { delta: null, growth: null }
  return { delta: now - before, growth: growthPercent(before, now) }
}
