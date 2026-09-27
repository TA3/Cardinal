import { detectIdLike } from "@/lib/core/id-like"
import type { LogGroup, LogLabelStat, LogsRange, LogsSnapshot, LogsSnapshotSummary } from "@/lib/core/logs/types"

// The logs snapshot: streams and bytes per group (service) and distinct values
// per label over a range, built from Loki's index APIs (index/volume and
// index/stats), never from raw lines. This file is pure; lib/sources/loki.ts
// fetches the pieces.

export const LOGS_RANGES: readonly LogsRange[] = ["1h", "24h", "7d"]

export const LOGS_RANGE_SECONDS: Record<LogsRange, number> = { "1h": 3600, "24h": 86400, "7d": 7 * 86400 }

export const LOGS_RANGE_LABEL: Record<LogsRange, string> = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days" }

export const DEFAULT_LOGS_RANGE: LogsRange = "24h"

/** Labels tried, in order, to group streams by when the user hasn't picked one. */
export const GROUP_LABEL_CANDIDATES = ["service_name", "job", "app"] as const

/** Groups that get a stream count (one index/stats call each). */
export const MAX_GROUPS = 50

/** Label values Cardinal keeps per label; more means `distinctValues` is a lower bound. */
export const MAX_LABEL_VALUES = 10_000

/** Values sampled per label for the ID-like check. */
const ID_SAMPLE = 200

/** Groups kept in a snapshot summary. */
export const SUMMARY_GROUPS = 200

export function isLogsRange(value: unknown): value is LogsRange {
  return LOGS_RANGES.includes(value as LogsRange)
}

/** Loki-internal labels such as __time_shard__ or __stream_shard__. */
export function isInternalLabel(label: string) {
  return label.startsWith("__")
}

/** The user's choice when Loki has it, else service_name, job, app, else the first label. */
export function pickGroupLabel(labels: string[], preferred?: string): string | null {
  const usable = labels.filter((label) => !isInternalLabel(label))
  if (preferred && usable.includes(preferred)) return preferred
  for (const candidate of GROUP_LABEL_CANDIDATES) if (usable.includes(candidate)) return candidate
  return usable[0] ?? null
}

/** A share in percent with two decimals, 0 when there is no total. */
function percent(part: number, total: number) {
  return total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0
}

export interface LogsSnapshotInput {
  host: string
  range: LogsRange
  groupLabel: string
  selector: string
  capturedAt?: string
  /** From index/stats over the whole selector. */
  totals: { streams: number; bytes: number; lines?: number }
  /** Bytes per group value from index/volume, any order. */
  volumes: Array<{ value: string; bytes: number }>
  /** Streams per group value from index/stats; only the top groups have one. */
  streamsByGroup: Record<string, number>
  labels: Array<{ label: string; values: string[] }>
}

export function buildLogsSnapshot(input: LogsSnapshotInput): LogsSnapshot {
  const volumes = [...input.volumes].sort((a, b) => b.bytes - a.bytes || a.value.localeCompare(b.value))
  const volumeTotal = volumes.reduce((sum, item) => sum + item.bytes, 0)
  // Volume and stats come from different index reads and differ slightly; shares use the volume sum so they add up.
  const shareBase = volumeTotal || input.totals.bytes
  const groups: LogGroup[] = volumes.slice(0, MAX_GROUPS).map((item) => ({
    value: item.value,
    bytes: item.bytes,
    streams: Object.hasOwn(input.streamsByGroup, item.value) ? input.streamsByGroup[item.value] : 0,
    share: percent(item.bytes, shareBase),
  }))

  let labelsTruncated = false
  const labels: LogLabelStat[] = input.labels
    .filter((item) => !isInternalLabel(item.label))
    .map((item) => {
      if (item.values.length >= MAX_LABEL_VALUES) labelsTruncated = true
      const idLike = detectIdLike(item.values.slice(0, ID_SAMPLE)) !== null
      return { label: item.label, distinctValues: Math.min(item.values.length, MAX_LABEL_VALUES), ...(idLike ? { idLike } : {}) }
    })
    .sort((a, b) => b.distinctValues - a.distinctValues || a.label.localeCompare(b.label))

  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    host: input.host,
    range: input.range,
    totals: {
      streams: input.totals.streams,
      bytes: input.totals.bytes || volumeTotal,
      ...(input.totals.lines !== undefined ? { lines: input.totals.lines } : {}),
      labelCount: labels.length,
    },
    groupLabel: input.groupLabel,
    groups,
    labels,
    selector: input.selector,
    groupCount: volumes.length,
    ...(volumes.length > MAX_GROUPS ? { groupsTruncated: true } : {}),
    ...(labelsTruncated ? { labelsTruncated: true } : {}),
  }
}

/** Bytes ingested per day at the snapshot's rate. */
export function bytesPerDay(snapshot: Pick<LogsSnapshot, "range" | "totals">) {
  return (snapshot.totals.bytes / LOGS_RANGE_SECONDS[snapshot.range]) * 86400
}

/** The largest group by bytes. */
export function largestGroup(snapshot: Pick<LogsSnapshot, "groups">): LogGroup | undefined {
  return snapshot.groups.reduce<LogGroup | undefined>((best, group) => (!best || group.bytes > best.bytes ? group : best), undefined)
}

export function summarizeLogsSnapshot(snapshot: LogsSnapshot, max = SUMMARY_GROUPS): LogsSnapshotSummary {
  const top = [...snapshot.groups].sort((a, b) => b.bytes - a.bytes).slice(0, max)
  return {
    capturedAt: snapshot.capturedAt,
    range: snapshot.range,
    groupLabel: snapshot.groupLabel,
    totals: { streams: snapshot.totals.streams, bytes: snapshot.totals.bytes },
    groups: Object.fromEntries(top.map((group) => [group.value, [group.bytes, group.streams]])),
    truncated: snapshot.groups.length > max || Boolean(snapshot.groupsTruncated),
  }
}

export interface LogsGroupChange {
  value: string
  before: number
  after: number
  delta: number
}

export interface LogsSnapshotDiff {
  /** False when the range or group label differ, so per-group numbers don't compare. */
  comparable: boolean
  bytesDelta: number
  streamsDelta: number
  /** Groups whose bytes grew, largest growth first. */
  growers: LogsGroupChange[]
  /** Groups absent from the previous snapshot, largest first. */
  added: LogsGroupChange[]
  /** Groups in the previous snapshot that are gone. */
  gone: number
}

/**
 * What changed since the previous snapshot. Bytes are compared as a rate per
 * day, so a 24h snapshot and a 7d one still give a sensible total delta.
 */
export function diffLogsSnapshots(previous: LogsSnapshotSummary, snapshot: LogsSnapshot): LogsSnapshotDiff {
  const comparable = previous.range === snapshot.range && previous.groupLabel === snapshot.groupLabel
  const perDay = (bytes: number, range: LogsRange) => (bytes / LOGS_RANGE_SECONDS[range]) * 86400
  const bytesDelta = Math.round(perDay(snapshot.totals.bytes, snapshot.range) - perDay(previous.totals.bytes, previous.range))
  const streamsDelta = snapshot.totals.streams - previous.totals.streams
  if (!comparable) return { comparable, bytesDelta, streamsDelta, growers: [], added: [], gone: 0 }

  const kept = Object.values(previous.groups).map(([bytes]) => bytes)
  // A truncated summary cut its smallest groups: a "new" group below that floor may have been cut.
  const floor = previous.truncated && kept.length ? Math.min(...kept) : 0
  const growers: LogsGroupChange[] = []
  const added: LogsGroupChange[] = []
  const now = new Set<string>()
  for (const group of snapshot.groups) {
    now.add(group.value)
    const before = Object.hasOwn(previous.groups, group.value) ? previous.groups[group.value][0] : undefined
    if (before === undefined) {
      if (group.bytes > floor) added.push({ value: group.value, before: 0, after: group.bytes, delta: group.bytes })
    } else if (group.bytes > before) {
      growers.push({ value: group.value, before, after: group.bytes, delta: group.bytes - before })
    }
  }
  // Groups past the current top list may still exist, so only count ones that should have been listed.
  const currentFloor = snapshot.groupsTruncated && snapshot.groups.length ? Math.min(...snapshot.groups.map((group) => group.bytes)) : 0
  const gone = Object.entries(previous.groups).filter(([value, [bytes]]) => !now.has(value) && bytes > currentFloor).length
  growers.sort((a, b) => b.delta - a.delta)
  added.sort((a, b) => b.delta - a.delta)
  return { comparable, bytesDelta, streamsDelta, growers, added, gone }
}

/** index/volume_range step for a range: about 50–60 points. */
export function volumeStepSeconds(range: LogsRange) {
  return range === "1h" ? 60 : range === "24h" ? 1800 : 3 * 3600
}

/** Sums per-series volume_range points into one total per timestamp, oldest first. */
export function sumVolumeSeries(series: Array<{ points: Array<{ t: number; value: number }> }>) {
  const totals = new Map<number, number>()
  for (const item of series) for (const point of item.points) totals.set(point.t, (totals.get(point.t) ?? 0) + point.value)
  return Array.from(totals.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({ t, value }))
}

/**
 * Active, measured and proposed log rules. Read defensively: rules come from
 * the store and may predate impacts.
 */
export function logRuleCounts(rules: unknown): { active: number; proposed: number; measured: number } {
  let active = 0
  let proposed = 0
  let measured = 0
  if (!Array.isArray(rules)) return { active, proposed, measured }
  for (const rule of rules as Array<{ status?: unknown; impact?: { bytesBefore?: unknown; bytesAfter?: unknown } }>) {
    if (rule?.status === "proposed") proposed += 1
    if (rule?.status !== "active") continue
    active += 1
    if (Number.isFinite(Number(rule.impact?.bytesBefore)) && Number.isFinite(Number(rule.impact?.bytesAfter))) measured += 1
  }
  return { active, proposed, measured }
}

/** "services" for service_name, "jobs" for job, else the label itself: how pages name the groups. */
export function groupNoun(groupLabel: string, plural = true) {
  if (groupLabel === "service_name" || groupLabel === "service") return plural ? "services" : "service"
  if (groupLabel === "job") return plural ? "jobs" : "job"
  if (groupLabel === "app") return plural ? "apps" : "app"
  if (groupLabel === "namespace") return plural ? "namespaces" : "namespace"
  return groupLabel
}
