import { describe, expect, it } from "vitest"

import {
  bytesOverTimeQuery,
  computeLogRuleImpact,
  computeLogSavings,
  detectedLevelFilter,
  logImpactQueries,
  queryResultValue,
  snapshotLogImpact,
  streamsWithoutLabel,
} from "@/lib/core/logs/impact"
import { createLogRule, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LabelMatcher, LogRule, LogRuleImpact, LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"

const measuredAt = "2026-09-26T12:00:00.000Z"
const sel = (...matchers: Array<[string, LabelMatcher["op"], string]>): StreamSelector => ({
  matchers: matchers.map(([label, op, value]) => ({ label, op, value })),
})
const api = sel(["service_name", "=", "api"])
const GiB = 1024 ** 3

function rule(input: Partial<LogRuleInput> & Pick<LogRuleInput, "kind">, impact?: Partial<LogRuleImpact>): LogRule {
  const created = createLogRule({ selector: api, origin: "user", ...input } as LogRuleInput)
  return impact ? { ...created, impact: { bytesBefore: 0, bytesAfter: 0, exact: true, measuredAt, ...impact } } : created
}

const snapshot: LogsSnapshot = {
  capturedAt: measuredAt,
  host: "loki",
  range: "24h",
  totals: { streams: 1000, bytes: 100 * GiB, labelCount: 10 },
  groupLabel: "service_name",
  groups: [
    { value: "api", streams: 200, bytes: 40 * GiB, share: 40 },
    { value: "web", streams: 100, bytes: 10 * GiB, share: 10 },
  ],
  labels: [],
}

describe("log impact queries", () => {
  it("builds stats, bytes and series queries per kind", () => {
    const opts = { range: "24h" }
    expect(logImpactQueries(rule({ kind: "drop_streams" }), opts)).toEqual({ stats: '{service_name="api"}' })
    expect(logImpactQueries(rule({ kind: "drop_lines", line: { regex: 'GET "/health"' } }), opts)).toEqual({
      stats: '{service_name="api"}',
      bytes: 'sum(bytes_over_time({service_name="api"} |~ "GET \\"/health\\"" [24h]))',
    })
    const levels = logImpactQueries(rule({ kind: "drop_lines", line: { levels: ["debug", "trace"] } }), opts)
    expect(levels.bytes).toBe('sum(bytes_over_time({service_name="api"} | detected_level=~"debug|trace" [24h]))')
    expect(levels.bytesFallback).toContain('|~ "(?i)\\\\b(?:level|lvl|severity)')
    expect(logImpactQueries(rule({ kind: "sample", keep: 0.5 }), opts)).toEqual({ stats: '{service_name="api"}' })
    expect(logImpactQueries(rule({ kind: "drop_label", label: "pod" }), opts).series).toBe('{service_name="api"}')
    expect(logImpactQueries(rule({ kind: "retention", days: 3 }), opts)).toEqual({ stats: '{service_name="api"}' })
  })

  it("substitutes a fallback for unscoped rules and validates the range", () => {
    const unscoped = rule({ kind: "drop_label", selector: sel(), label: "pod" })
    expect(logImpactQueries(unscoped, { range: "1h" }).stats).toBe('{service_name=~".+"}')
    expect(logImpactQueries(unscoped, { range: "1h", everything: sel(["job", "=~", ".+"]) }).stats).toBe('{job=~".+"}')
    expect(() => logImpactQueries(rule({ kind: "drop_streams" }), { range: "1h]) or vector(1" })).toThrow(/range/)
    expect(() => bytesOverTimeQuery(api, { regex: "x" }, { range: "" })).toThrow(/range/)
  })

  it("escapes level values and rejects injected selectors", () => {
    expect(detectedLevelFilter(["Warn", "err.or"])).toBe(' | detected_level=~"err\\\\.or|warn"')
    const injected = { ...rule({ kind: "drop_streams" }), selector: sel(["app", "=", 'x"} or vector(1) #\n']) }
    expect(() => logImpactQueries(injected, { range: "1h" })).toThrow(/control/)
  })
})

describe("query results", () => {
  it("sums vectors and matrix last points, null when empty", () => {
    expect(queryResultValue({ resultType: "vector", result: [{ value: [1, "10"] }, { value: [1, "5.5"] }] })).toBe(15.5)
    expect(queryResultValue({ data: { resultType: "matrix", result: [{ values: [[1, "1"], [2, "7"]] }] } })).toBe(7)
    expect(queryResultValue({ resultType: "scalar", result: [1, "3"] })).toBe(3)
    expect(queryResultValue({ resultType: "vector", result: [] })).toBeNull()
    expect(queryResultValue({ resultType: "streams", result: [] })).toBeNull()
    expect(queryResultValue(null)).toBeNull()
    expect(queryResultValue({ resultType: "vector", result: [{ value: [1, "NaN"] }] })).toBe(0)
  })

  it("counts distinct label sets without a label", () => {
    const series: Array<Record<string, string>> = [
      { app: "a", pod: "1" },
      { app: "a", pod: "2" },
      { pod: "3", app: "b" },
      { app: "b", pod: "4", __stream_shard__: "1" },
    ]
    expect(streamsWithoutLabel(series, "pod")).toBe(2)
    expect(streamsWithoutLabel(series, "app")).toBe(4)
    expect(streamsWithoutLabel([], "pod")).toBe(0)
  })
})

describe("log rule impact", () => {
  const stats = { streams: 50, chunks: 10, entries: 1000, bytes: 8 * GiB }

  it("drop_streams: exact bytes and streams", () => {
    expect(computeLogRuleImpact(rule({ kind: "drop_streams" }), { stats, measuredAt })).toEqual({
      bytesBefore: 8 * GiB,
      bytesAfter: 0,
      streamsBefore: 50,
      streamsAfter: 0,
      exact: true,
      measuredAt,
    })
    expect(computeLogRuleImpact(rule({ kind: "drop_streams" }), {})).toBeNull()
  })

  it("drop_lines: selector bytes minus filtered bytes, approximate for levels", () => {
    const regex = computeLogRuleImpact(rule({ kind: "drop_lines", line: { regex: "x" } }), { stats, matchedBytes: 2 * GiB })!
    expect(regex).toMatchObject({ bytesBefore: 8 * GiB, bytesAfter: 6 * GiB, exact: true })
    const levels = computeLogRuleImpact(rule({ kind: "drop_lines", line: { levels: ["debug"] } }), {
      stats,
      matchedBytes: 3 * GiB,
      viaLineText: true,
    })!
    expect(levels).toMatchObject({ bytesAfter: 5 * GiB, exact: false })
    expect(levels.note).toMatch(/line text/)
    // Filtered bytes above the stats bytes (different accounting) never go negative.
    expect(computeLogRuleImpact(rule({ kind: "drop_lines", line: { regex: "x" } }), { stats, matchedBytes: 9 * GiB })).toMatchObject({
      bytesBefore: 9 * GiB,
      bytesAfter: 0,
    })
    expect(computeLogRuleImpact(rule({ kind: "drop_lines", line: { regex: "x" } }), { stats, matchedBytes: null })).toBeNull()
  })

  it("sample: bytes × (1 − keep), always approximate", () => {
    const all = computeLogRuleImpact(rule({ kind: "sample", keep: 0.25 }), { stats })!
    expect(all).toMatchObject({ bytesBefore: 8 * GiB, bytesAfter: 2 * GiB, exact: false })
    const filtered = computeLogRuleImpact(rule({ kind: "sample", keep: 0.5, line: { regex: "x" } }), { stats, matchedBytes: 4 * GiB })!
    expect(filtered.bytesAfter).toBe(6 * GiB)
  })

  it("drop_label: distinct remaining sets, scaled when the listing is capped", () => {
    const series = [
      { app: "a", pod: "1" },
      { app: "a", pod: "2" },
      { app: "b", pod: "3" },
      { app: "b", pod: "4" },
    ]
    const exact = computeLogRuleImpact(rule({ kind: "drop_label", label: "pod" }), { stats: { ...stats, streams: 4 }, series })!
    expect(exact).toMatchObject({ bytesBefore: 8 * GiB, bytesAfter: 8 * GiB, streamsBefore: 4, streamsAfter: 2, exact: true })
    const capped = computeLogRuleImpact(rule({ kind: "drop_label", label: "pod" }), { stats: { ...stats, streams: 400 }, series, seriesCap: 4 })!
    expect(capped).toMatchObject({ streamsBefore: 400, streamsAfter: 200, exact: false })
    const move = computeLogRuleImpact(rule({ kind: "label_to_metadata", label: "pod" }), { stats: { ...stats, streams: 4 }, series })!
    expect(move.note).toMatch(/index/)
    expect(move.bytesAfter).toBe(move.bytesBefore)
    expect(computeLogRuleImpact(rule({ kind: "drop_label", label: "pod" }), { stats })).toBeNull()
  })

  it("retention: storage only, with saved days", () => {
    const impact = computeLogRuleImpact(rule({ kind: "retention", days: 7 }), { stats, currentRetentionDays: 30, rangeDays: 1 })!
    expect(impact).toMatchObject({ bytesBefore: 8 * GiB, bytesAfter: 8 * GiB, retentionSavedDays: 23, exact: true })
    expect(impact.note).toMatch(/184 GiB/)
    const unknown = computeLogRuleImpact(rule({ kind: "retention", days: 7 }), {})!
    expect(unknown.retentionSavedDays).toBeUndefined()
    expect(unknown.note).toBe("Storage only: ingest is unchanged.")
  })

  it("derives stream drops of one group from the snapshot", () => {
    expect(snapshotLogImpact(rule({ kind: "drop_streams" }), snapshot)).toMatchObject({ bytesBefore: 40 * GiB, streamsBefore: 200, exact: true })
    expect(snapshotLogImpact(rule({ kind: "drop_streams", selector: sel(["service_name", "=", "nope"]) }), snapshot)).toBeNull()
    expect(snapshotLogImpact(rule({ kind: "drop_streams", selector: sel(["app", "=", "api"]) }), snapshot)).toBeNull()
    expect(snapshotLogImpact(rule({ kind: "drop_label", label: "pod" }), snapshot)).toBeNull()
  })
})

describe("computeLogSavings", () => {
  it("is zero without a snapshot or active rules", () => {
    expect(computeLogSavings([rule({ kind: "drop_streams" })], null).savedBytes).toBe(0)
    expect(computeLogSavings([rule({ kind: "drop_streams", status: "proposed" })], snapshot).savedBytes).toBe(0)
  })

  it("uses snapshot groups and measured impacts", () => {
    const web = rule({ kind: "drop_streams", selector: sel(["service_name", "=", "web"]) })
    const savings = computeLogSavings([rule({ kind: "drop_streams" }), web], snapshot)
    expect(savings).toMatchObject({ savedBytes: 50 * GiB, savedStreams: 300, percent: 50, streamsPercent: 30, isEstimate: false })
  })

  it("does not double count rules under a broader stream drop", () => {
    const drop = rule({ kind: "drop_streams" })
    const lines = rule({ kind: "drop_lines", line: { regex: "x" } }, { bytesBefore: 40 * GiB, bytesAfter: 30 * GiB })
    const label = rule({ kind: "drop_label", label: "pod" }, { bytesBefore: 1, bytesAfter: 1, streamsBefore: 200, streamsAfter: 20 })
    expect(computeLogSavings([drop, lines, label], snapshot)).toMatchObject({ savedBytes: 40 * GiB, savedStreams: 200, isEstimate: false })
  })

  it("caps line rules on one selector at its bytes and flags overlap", () => {
    const a = rule({ kind: "drop_lines", line: { regex: "a" } }, { bytesBefore: 10 * GiB, bytesAfter: 2 * GiB })
    const b = rule({ kind: "drop_lines", line: { regex: "b" } }, { bytesBefore: 10 * GiB, bytesAfter: 4 * GiB })
    const savings = computeLogSavings([a, b], snapshot)
    expect(savings.savedBytes).toBe(10 * GiB)
    expect(savings.isEstimate).toBe(true)
  })

  it("flags selectors that may overlap and caps at the snapshot total", () => {
    const a = rule({ kind: "drop_streams", selector: sel(["namespace", "=", "a"]) }, { bytesBefore: 80 * GiB, streamsBefore: 900 })
    const b = rule({ kind: "drop_streams", selector: sel(["cluster", "=", "b"]) }, { bytesBefore: 80 * GiB, streamsBefore: 900 })
    const savings = computeLogSavings([a, b], snapshot)
    expect(savings).toMatchObject({ savedBytes: 100 * GiB, savedStreams: 1000, percent: 100, isEstimate: true })
  })

  it("marks unmeasured rules as an estimate but not retention", () => {
    expect(computeLogSavings([rule({ kind: "drop_label", label: "pod" })], snapshot).isEstimate).toBe(true)
    expect(computeLogSavings([rule({ kind: "retention", days: 3 })], snapshot).isEstimate).toBe(false)
  })

  it("counts label rules as streams, not bytes, and sums label groups", () => {
    const pod = rule({ kind: "drop_label", label: "pod" }, { bytesBefore: 5, bytesAfter: 5, streamsBefore: 200, streamsAfter: 50 })
    const node = rule({ kind: "label_to_metadata", selector: sel(["service_name", "=", "web"]), label: "trace_id" }, {
      bytesBefore: 5,
      bytesAfter: 5,
      streamsBefore: 100,
      streamsAfter: 10,
      exact: false,
    })
    expect(computeLogSavings([pod, node], snapshot)).toMatchObject({ savedBytes: 0, savedStreams: 240, isEstimate: true })
  })
})
