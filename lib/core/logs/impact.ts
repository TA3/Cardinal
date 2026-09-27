// What a log rule saves, from Loki's own numbers. The UI runs the queries from
// logImpactQueries, then hands the results to computeLogRuleImpact; everything
// here is pure. Impacts should be measured over the snapshot's range so that
// computeLogSavings can compare them with the snapshot totals.

import { activeLogRules, keepCoversAll, logRuleProtectedBy, logRuleShadowedBy } from "@/lib/core/logs/rules"
import {
  EVERYTHING,
  levelLineRegex,
  normalizeLevels,
  renderLineFilter,
  renderSelector,
  selectorContains,
  selectorKey,
  selectorsDisjoint,
} from "@/lib/core/logs/selector"
import type { KeepRule, LineFilter, LogRule, LogRuleImpact, LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { quoteLogQLValue } from "@/lib/core/logql"
import { escapeRegex } from "@/lib/core/regex"

/** Streams listed per label-drop estimate; beyond this the result is scaled and approximate. */
export const SERIES_CAP = 5000

const DURATION = /^\d+(ms|s|m|h|d|w|y)$/

export class InvalidRangeError extends Error {
  constructor(range: string) {
    super(`Invalid LogQL range: ${JSON.stringify(range)}`)
    this.name = "InvalidRangeError"
  }
}

function rangeLiteral(range: string) {
  if (!DURATION.test(range)) throw new InvalidRangeError(range)
  return range
}

export interface LogImpactQueryOptions {
  /** A LogQL duration: "1h", "24h", "7d". */
  range: string
  /** Stands in for an empty (all streams) selector, which Loki refuses. */
  everything?: StreamSelector
}

export interface LogImpactQueries {
  /** `query` for GET /loki/api/v1/index/stats over the range: streams and bytes the selector covers. */
  stats: string
  /** Instant LogQL (evaluated at the range end): bytes the rule's line filter matches over the range. */
  bytes?: string
  /**
   * Level rules: the same bytes via the line text (`level=debug`), for Lokis
   * without detected_level. Use it when `bytes` returns nothing.
   */
  bytesFallback?: string
  /** `match[]` for GET /loki/api/v1/series; list at most SERIES_CAP streams. */
  series?: string
}

/** `| detected_level=~"debug|trace"`: Loki 3 stores the detected level as structured metadata. */
export function detectedLevelFilter(levels: string[]) {
  return ` | detected_level=~${quoteLogQLValue(normalizeLevels(levels).map(escapeRegex).join("|"))}`
}

/** `sum(bytes_over_time({…} |~ "…" [24h]))`. */
export function bytesOverTimeQuery(selector: StreamSelector, line: LineFilter | undefined, options: LogImpactQueryOptions) {
  const sel = renderSelector(selector, options.everything ?? EVERYTHING)
  return `sum(bytes_over_time(${sel}${renderLineFilter(line)} [${rangeLiteral(options.range)}]))`
}

function levelBytesQueries(selector: StreamSelector, levels: string[], options: LogImpactQueryOptions) {
  const sel = renderSelector(selector, options.everything ?? EVERYTHING)
  const range = rangeLiteral(options.range)
  return {
    bytes: `sum(bytes_over_time(${sel}${detectedLevelFilter(levels)} [${range}]))`,
    bytesFallback: `sum(bytes_over_time(${sel} |~ ${quoteLogQLValue(levelLineRegex(levels))} [${range}]))`,
  }
}

/** The Loki requests a rule's impact needs. Throws on an invalid selector or range. */
export function logImpactQueries(rule: LogRule, options: LogImpactQueryOptions): LogImpactQueries {
  const stats = renderSelector(rule.selector, options.everything ?? EVERYTHING)
  rangeLiteral(options.range)
  switch (rule.kind) {
    case "drop_lines":
    case "sample":
    case "keep": {
      const line = rule.line
      if (!line) return { stats }
      if (line.levels?.length) return { stats, ...levelBytesQueries(rule.selector, line.levels, options) }
      return { stats, bytes: bytesOverTimeQuery(rule.selector, line, options) }
    }
    case "drop_label":
    case "label_to_metadata":
      return { stats, series: stats }
    default:
      return { stats }
  }
}

// ---- results ----

export interface LokiIndexStats {
  streams: number
  chunks?: number
  entries?: number
  bytes: number
}

/** Loki's `data` of a query / query_range response. */
export interface LokiQueryData {
  resultType: string
  result: unknown
}

function toNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * Sum of a metric query result: vector values, or the last point of each
 * matrix series. Accepts the full response or its `data`. Null when there are
 * no samples at all (e.g. no detected_level), so callers can try a fallback.
 */
export function queryResultValue(response: LokiQueryData | { data: LokiQueryData } | null | undefined): number | null {
  const data = response && "data" in response ? response.data : response
  if (!data || !Array.isArray(data.result) || data.resultType === "streams") return null
  if (data.resultType === "scalar") return toNumber((data.result as unknown[])[1])
  const rows = data.result as Array<{ value?: [number, string]; values?: Array<[number, string]> }>
  let total = 0
  let samples = 0
  for (const row of rows) {
    const sample = row.value ?? row.values?.[row.values.length - 1]
    if (!sample) continue
    total += toNumber(sample[1])
    samples += 1
  }
  return samples ? total : null
}

/** Distinct label sets once `label` is removed: the streams a label drop leaves. */
export function streamsWithoutLabel(series: Array<Record<string, string>>, label: string) {
  const sets = new Set<string>()
  for (const stream of series) {
    const rest = Object.entries(stream)
      .filter(([name]) => name !== label && !name.startsWith("__"))
      .sort(([a], [b]) => a.localeCompare(b))
    sets.add(JSON.stringify(rest))
  }
  return sets.size
}

export interface LogImpactInputs {
  /** index/stats for the rule's selector. */
  stats?: LokiIndexStats
  /** Result of the `bytes` (or `bytesFallback`) query. */
  matchedBytes?: number | null
  /** True when matchedBytes came from `bytesFallback` (line text) rather than detected_level. */
  viaLineText?: boolean
  /** /series listing for the selector (label rules). */
  series?: Array<Record<string, string>>
  /** The cap the listing was requested with. */
  seriesCap?: number
  /** Current retention of the selected streams, for retention rules. */
  currentRetentionDays?: number
  /** Length of the measured range in days (bytes per day for retention notes); defaults to 1. */
  rangeDays?: number
  measuredAt?: string
}

function formatGiB(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`
}

/**
 * The impact of one rule from query results, or null when an input it needs is
 * missing:
 * - drop_streams: exact bytes and streams from index/stats;
 * - drop_lines: stats bytes minus the filtered bytes_over_time (approximate for levels);
 * - sample: bytes × (1 − keep) of the matching lines, always approximate;
 * - drop_label / label_to_metadata: distinct remaining label sets from the series
 *   listing (scaled and approximate when capped); bytes unchanged;
 * - retention: bytes unchanged, retentionSavedDays when the current retention is known;
 * - keep: saves nothing; bytesBefore = bytesAfter = the bytes it protects.
 */
export function computeLogRuleImpact(rule: LogRule, inputs: LogImpactInputs): LogRuleImpact | null {
  const measuredAt = inputs.measuredAt ?? new Date().toISOString()
  const stats = inputs.stats
  switch (rule.kind) {
    case "drop_streams":
      if (!stats) return null
      return { bytesBefore: stats.bytes, bytesAfter: 0, streamsBefore: stats.streams, streamsAfter: 0, exact: true, measuredAt }
    case "drop_lines":
    case "sample": {
      if (!stats) return null
      const needsFilter = rule.line !== undefined
      if (needsFilter && (inputs.matchedBytes === undefined || inputs.matchedBytes === null)) return null
      const before = Math.max(stats.bytes, needsFilter ? inputs.matchedBytes! : 0)
      const matched = needsFilter ? Math.min(inputs.matchedBytes!, before) : before
      const cut = rule.kind === "sample" ? matched * (1 - rule.keep) : matched
      const levels = Boolean(rule.line?.levels?.length)
      const notes = [
        rule.kind === "sample" ? "Sampling is random; the saving is the expected value." : "",
        levels ? `Level matched via ${inputs.viaLineText ? "the line text" : "detected_level"}; the collector matches the line text.` : "",
      ].filter(Boolean)
      return {
        bytesBefore: before,
        bytesAfter: Math.max(0, before - cut),
        streamsBefore: stats.streams,
        streamsAfter: stats.streams,
        exact: rule.kind === "drop_lines" && !levels,
        measuredAt,
        ...(notes.length ? { note: notes.join(" ") } : {}),
      }
    }
    case "drop_label":
    case "label_to_metadata": {
      const series = inputs.series
      if (!series) return null
      const listed = series.length
      const streamsBefore = Math.max(stats?.streams ?? listed, listed)
      const capped = listed >= (inputs.seriesCap ?? SERIES_CAP) || streamsBefore > listed
      const distinct = streamsWithoutLabel(series, rule.label)
      const streamsAfter = listed === 0 ? 0 : capped ? Math.max(1, Math.round((streamsBefore * distinct) / listed)) : distinct
      const bytes = stats?.bytes ?? 0
      return {
        bytesBefore: bytes,
        bytesAfter: bytes,
        streamsBefore,
        streamsAfter: Math.min(streamsAfter, streamsBefore),
        exact: !capped,
        measuredAt,
        note:
          rule.kind === "label_to_metadata"
            ? "The index and stream count shrink; ingested bytes don't (the value moves to structured metadata)."
            : "Streams merge; ingested bytes are unchanged.",
      }
    }
    case "keep": {
      if (!stats) return null
      if (rule.line && (inputs.matchedBytes === undefined || inputs.matchedBytes === null)) return null
      const kept = rule.line ? Math.min(inputs.matchedBytes!, Math.max(stats.bytes, inputs.matchedBytes!)) : stats.bytes
      return {
        bytesBefore: kept,
        bytesAfter: kept,
        streamsBefore: stats.streams,
        streamsAfter: stats.streams,
        exact: !rule.line?.levels?.length,
        measuredAt,
      }
    }
    case "retention": {
      const bytes = stats?.bytes ?? 0
      const saved = inputs.currentRetentionDays !== undefined ? Math.max(0, inputs.currentRetentionDays - rule.days) : undefined
      const perDay = bytes / Math.max(inputs.rangeDays ?? 1, 1 / 24)
      const note =
        saved !== undefined && saved > 0 && bytes > 0
          ? `Storage only: ingest is unchanged; about ${formatGiB(perDay * saved)} less kept at steady state.`
          : "Storage only: ingest is unchanged."
      return {
        bytesBefore: bytes,
        bytesAfter: bytes,
        ...(stats ? { streamsBefore: stats.streams, streamsAfter: stats.streams } : {}),
        exact: true,
        measuredAt,
        ...(saved !== undefined ? { retentionSavedDays: saved } : {}),
        note,
      }
    }
  }
}

/**
 * Impact straight from the snapshot, without a query: a drop_streams on exactly
 * one group (`{service_name="api"}`) removes that group's streams and bytes.
 */
export function snapshotLogImpact(rule: Pick<LogRule, "kind" | "selector">, snapshot: LogsSnapshot | null): LogRuleImpact | null {
  if (!snapshot || rule.kind !== "drop_streams" || rule.selector.matchers.length !== 1) return null
  const [matcher] = rule.selector.matchers
  if (matcher.op !== "=" || matcher.label !== snapshot.groupLabel) return null
  const group = snapshot.groups.find((item) => item.value === matcher.value)
  if (!group) return null
  return {
    bytesBefore: group.bytes,
    bytesAfter: 0,
    streamsBefore: group.streams,
    streamsAfter: 0,
    exact: true,
    measuredAt: snapshot.capturedAt,
  }
}

export interface LogSavings {
  savedBytes: number
  savedStreams: number
  /** Share of the snapshot's bytes, 0–100. */
  percent: number
  /** Share of the snapshot's streams, 0–100. */
  streamsPercent: number
  isEstimate: boolean
}

interface Region {
  selector: StreamSelector
  bytes: number
}

/**
 * What active keeps take back from a region that removes `saved` of its `cap`
 * bytes: the kept bytes inside it, removed at the region's rate. A keep of every
 * line of a containing selector protects it all; a keep inside the region
 * counts in full; a partial overlap counts in full too (capped), as an estimate.
 */
export function keptSavings(selector: StreamSelector, cap: number, saved: number, keeps: KeepRule[], line?: LineFilter): { bytes: number; estimate: boolean } {
  if (cap <= 0 || saved <= 0) return { bytes: 0, estimate: false }
  let kept = 0
  let estimate = false
  for (const keep of keeps) {
    if (selectorsDisjoint(keep.selector, selector)) continue
    if (!keep.impact) {
      estimate = true
      continue
    }
    if (keepCoversAll(keep, selector, line)) return { bytes: saved, estimate: false }
    if (!keep.impact.exact || !selectorContains(selector, keep.selector)) estimate = true
    kept += keep.impact.bytesBefore
  }
  const rate = Math.min(1, saved / cap)
  // Kept lines are removed at the region's average rate unless it removes everything.
  if (rate < 1 && kept > 0) estimate = true
  return { bytes: Math.min(saved, Math.min(kept, cap) * rate), estimate }
}

/**
 * Bytes and streams the active rules remove, like metrics computeExpectedSavings:
 * rules another rule shadows are skipped (a drop_streams covers everything
 * narrower); line rules on one selector are summed but capped at that
 * selector's bytes; overlapping selectors that can't be proven disjoint make
 * the total an estimate; totals are capped at the snapshot's. Unmeasured rules
 * (other than snapshot-derived stream drops) count once measured.
 */
export function computeLogSavings(logRules: LogRule[], snapshot: LogsSnapshot | null): LogSavings {
  const active = activeLogRules(logRules)
  const none = { savedBytes: 0, savedStreams: 0, percent: 0, streamsPercent: 0, isEstimate: false }
  if (!snapshot || active.length === 0) return none

  let isEstimate = false
  const regions: Region[] = []
  const lineGroups = new Map<string, { selector: StreamSelector; cap: number; saved: number; rules: number }>()
  const labelGroups = new Map<string, { cap: number; saved: number; rules: number }>()
  let droppedStreams = 0

  const keeps = active.filter((rule): rule is KeepRule => rule.kind === "keep")
  for (const rule of active) {
    if (rule.kind === "keep" || logRuleShadowedBy(rule, active) || logRuleProtectedBy(rule, active)) continue
    const impact = rule.impact ?? snapshotLogImpact(rule, snapshot)
    if (!impact) {
      if (rule.kind !== "retention") isEstimate = true
      continue
    }
    if (!impact.exact) isEstimate = true
    const bytes = Math.max(0, impact.bytesBefore - impact.bytesAfter)
    const streams = Math.max(0, (impact.streamsBefore ?? 0) - (impact.streamsAfter ?? impact.streamsBefore ?? 0))
    const key = selectorKey(rule.selector)

    if (rule.kind === "drop_streams") {
      const kept = keptSavings(rule.selector, impact.bytesBefore, bytes, keeps)
      if (kept.estimate) isEstimate = true
      regions.push({ selector: rule.selector, bytes: bytes - kept.bytes })
      // Kept lines keep their streams alive.
      droppedStreams += kept.bytes > 0 ? 0 : (impact.streamsBefore ?? 0)
    } else if (rule.kind === "drop_lines" || rule.kind === "sample") {
      const group = lineGroups.get(key) ?? { selector: rule.selector, cap: 0, saved: 0, rules: 0 }
      group.cap = Math.max(group.cap, impact.bytesBefore)
      group.saved += bytes
      group.rules += 1
      lineGroups.set(key, group)
    } else if (rule.kind === "drop_label" || rule.kind === "label_to_metadata") {
      const group = labelGroups.get(key) ?? { cap: 0, saved: 0, rules: 0 }
      group.cap = Math.max(group.cap, Math.max(0, (impact.streamsBefore ?? 0) - 1))
      group.saved += streams
      group.rules += 1
      labelGroups.set(key, group)
    }
  }

  for (const group of lineGroups.values()) {
    // Two filters on one selector may match the same lines.
    if (group.rules > 1) isEstimate = true
    const saved = Math.min(group.saved, group.cap)
    const kept = keptSavings(group.selector, group.cap, saved, keeps)
    if (kept.estimate) isEstimate = true
    regions.push({ selector: group.selector, bytes: saved - kept.bytes })
  }
  for (let i = 0; i < regions.length && !isEstimate; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      if (regions[i].bytes > 0 && regions[j].bytes > 0 && !selectorsDisjoint(regions[i].selector, regions[j].selector)) {
        isEstimate = true
        break
      }
    }
  }
  let labelStreams = 0
  for (const group of labelGroups.values()) {
    if (group.rules > 1) isEstimate = true
    labelStreams += Math.min(group.saved, group.cap)
  }

  const { bytes: totalBytes, streams: totalStreams } = snapshot.totals
  const rawBytes = regions.reduce((sum, region) => sum + region.bytes, 0)
  const rawStreams = droppedStreams + labelStreams
  const savedBytes = totalBytes > 0 ? Math.min(rawBytes, totalBytes) : rawBytes
  const savedStreams = totalStreams > 0 ? Math.min(rawStreams, totalStreams) : rawStreams
  return {
    savedBytes: Math.round(savedBytes),
    savedStreams: Math.round(savedStreams),
    percent: totalBytes > 0 ? Math.min(100, (savedBytes / totalBytes) * 100) : 0,
    streamsPercent: totalStreams > 0 ? Math.min(100, (savedStreams / totalStreams) * 100) : 0,
    isEstimate,
  }
}
