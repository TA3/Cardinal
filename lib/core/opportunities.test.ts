import { describe, expect, it } from "vitest"

import type { ClassicHistogram } from "@/lib/core/histograms"
import { createLogRule } from "@/lib/core/logs/rules"
import {
  bigMetrics,
  bucketOpportunities,
  churnOpportunity,
  idCheckCandidates,
  idLikeOpportunity,
  labelOpportunities,
  patternOpportunities,
  rankLogOpportunities,
  rankOpportunities,
  reasonLabel,
  ruleCovers,
  unusedMetricOpportunities,
} from "@/lib/core/opportunities"
import { createRule } from "@/lib/core/rules"

const verdict = { kind: "uuid" as const, share: 0.9, examples: ["0b4f…"] }

function family(bucketMetric: string, les: number, labelSets: number): ClassicHistogram {
  const values = Array.from({ length: les - 1 }, (_, index) => String(2 ** index / 1000)).concat("+Inf")
  return {
    base: bucketMetric.replace(/_bucket$/, ""),
    bucketMetric,
    bucketSeries: les * labelSets,
    sumSeries: labelSets,
    countSeries: labelSets,
    familySeries: (les + 2) * labelSets,
    les: values,
    seriesByLe: Object.fromEntries(values.map((le) => [le, labelSets])),
    labelSets,
    seriesPerLabelSet: les + 2,
    alsoNative: false,
  }
}

describe("metric opportunities", () => {
  it("picks big metrics and only checked-unused ones", () => {
    const metrics = [
      { metric: "a", seriesCount: 10 },
      { metric: "b", seriesCount: 900 },
      { metric: "c", seriesCount: 400 },
      { metric: "d", seriesCount: 300 },
    ]
    expect(bigMetrics(metrics, { limit: 2, minSeries: 50 }).map((item) => item.metric)).toEqual(["b", "c"])
    const items = unusedMetricOpportunities(metrics, { b: false, c: true, d: undefined })
    expect(items.map((item) => item.metric)).toEqual(["b"])
    expect(items[0]).toMatchObject({ reason: "unused", savedSeries: 900, estimate: false, rule: { kind: "drop_metric", metric: "b" } })
  })

  it("checks only droppable high-cardinality labels for IDs", () => {
    const labels = [
      { label: "instance", cardinality: 500 },
      { label: "le", cardinality: 30 },
      { label: "user_id", cardinality: 300 },
      { label: "path", cardinality: 40 },
      { label: "code", cardinality: 5 },
    ]
    expect(idCheckCandidates(labels).map((item) => item.label)).toEqual(["user_id", "path"])
  })

  it("turns a measured ID-like label into a drop, defaulting unused merges to drop anyway", () => {
    const impact = { seriesBefore: 1000, seriesAfter: 40, mergesSeries: true }
    const unused = idLikeOpportunity({ metric: "http_requests_total", label: "user_id", verdict, impact, used: false })
    expect(unused).toMatchObject({ savedSeries: 960, rule: { kind: "drop_labels", labels: ["user_id"], onMerge: "drop" } })
    const used = idLikeOpportunity({ metric: "http_requests_total", label: "user_id", verdict, impact, used: true })
    expect(used?.rule).not.toHaveProperty("onMerge")
    expect(idLikeOpportunity({ metric: "m", label: "id", verdict, impact: { seriesBefore: 10, seriesAfter: 10, mergesSeries: false }, used: false })).toBeNull()
  })

  it("trims bucket-heavy histograms and skips small ones", () => {
    const items = bucketOpportunities([family("big_bucket", 20, 50), family("small_bucket", 6, 50)])
    expect(items.map((item) => item.metric)).toEqual(["big_bucket"])
    expect(items[0].estimate).toBe(true)
    expect(items[0].rule.kind).toBe("keep_buckets")
    if (items[0].rule.kind === "keep_buckets") {
      expect(items[0].rule.buckets).toContain("+Inf")
      expect(items[0].rule.buckets.length).toBeLessThan(20)
    }
    expect(items[0].savedSeries).toBeGreaterThan(0)
  })

  it("proposes dropping a churn driver, never a guarded label", () => {
    expect(churnOpportunity({ metric: "m", job: "api", label: "pod", churned: 300, used: false })).toMatchObject({
      reason: "churn",
      savedSeries: 300,
      rule: { kind: "drop_labels", job: "api", labels: ["pod"], onMerge: "drop" },
    })
    expect(churnOpportunity({ metric: "m", job: "api", label: "instance", churned: 300, used: false })).toBeNull()
    expect(churnOpportunity({ metric: "m", job: "api", label: "pod", churned: 0, used: false })).toBeNull()
  })

  it("ranks by series saved, dedupes, and follows existing rules", () => {
    const unused = unusedMetricOpportunities([{ metric: "big", seriesCount: 5000 }], { big: false })
    const id = idLikeOpportunity({ metric: "big", label: "uid", verdict, impact: { seriesBefore: 5000, seriesAfter: 10, mergesSeries: true }, used: false })!
    const other = idLikeOpportunity({ metric: "other", label: "uid", verdict, impact: { seriesBefore: 800, seriesAfter: 10, mergesSeries: true }, used: false })!
    const churn = churnOpportunity({ metric: "other", job: "api", label: "uid", churned: 200, used: false })!
    const buckets = bucketOpportunities([family("lat_bucket", 20, 100)])
    const all = [...buckets, churn, other, id, ...unused]

    const ranked = rankOpportunities(all)
    // "big" can go whole, so its label item is hidden; "other" uid shows once (the larger saving).
    expect(ranked.map((item) => [item.reason, item.metric])).toEqual([
      ["unused", "big"],
      ["buckets", "lat_bucket"],
      ["id_like", "other"],
    ])
    expect(ranked.every((item) => item.state === "open")).toBe(true)

    const rules = [
      createRule({ kind: "drop_metric", selector: { metric: "big" }, origin: "user", status: "active" }),
      createRule({ kind: "drop_labels", selector: { metric: "other" }, labels: ["uid", "x"], origin: "user", status: "proposed" }),
      createRule({ kind: "keep_buckets", selector: { metric: "lat_bucket" }, buckets: ["1"], origin: "user", status: "rejected" }),
    ]
    const after = rankOpportunities(all, rules)
    expect(after.map((item) => [item.metric, item.state])).toEqual([["other", "proposed"]])
  })

  it("scopes coverage by job", () => {
    const jobRule = createRule({ kind: "drop_metric", selector: { metric: "m", job: "a" }, origin: "user" })
    const allJobs = createRule({ kind: "drop_metric", selector: { metric: "m" }, origin: "user" })
    expect(ruleCovers(jobRule, { kind: "drop_metric", metric: "m" })).toBe(false)
    expect(ruleCovers(allJobs, { kind: "drop_labels", metric: "m", job: "a", labels: ["pod"] })).toBe(true)
  })
})

describe("log opportunities", () => {
  const services = [
    {
      service: "api",
      patterns: [
        { pattern: "GET /health <_>", level: "info", lineShare: 0.5, bytesPerDay: 400 * 1024 ** 2, regex: "GET /health .*" },
        { pattern: "cache miss <_>", level: "debug", lineShare: 0.2, bytesPerDay: 160 * 1024 ** 2, regex: "cache miss .*" },
        { pattern: "boom <_>", level: "error", lineShare: 0.3, bytesPerDay: 240 * 1024 ** 2, regex: "boom .*" },
      ],
    },
    { service: "quiet", patterns: [{ pattern: "tick", level: "info", lineShare: 0.05, bytesPerDay: 1024, regex: "tick" }] },
  ]

  it("finds noisy patterns and debug lines per service", () => {
    const items = patternOpportunities("service_name", services)
    expect(items.map((item) => [item.reason, item.title])).toEqual([
      ["debug", "api"],
      ["noisy", "GET /health <_>"],
    ])
    const noisy = items.find((item) => item.reason === "noisy")!
    expect(noisy.rule).toMatchObject({ kind: "sample", keep: 0.1, line: { regex: "GET /health .*" } })
    expect(noisy.savedBytesPerDay).toBeCloseTo(360 * 1024 ** 2)
    expect(items.find((item) => item.reason === "debug")!.rule).toMatchObject({ kind: "drop_lines", line: { levels: ["debug", "trace"] } })
  })

  it("moves strong labels to metadata and ranks bytes first", () => {
    const labels = labelOpportunities([
      { label: "trace_id", distinctValues: 5000, idLike: true, move: true },
      { label: "env", distinctValues: 3, move: false },
    ])
    expect(labels.map((item) => item.title)).toEqual(["trace_id"])
    const ranked = rankLogOpportunities([...labels, ...patternOpportunities("service_name", services)])
    expect(ranked.map((item) => item.reason)).toEqual(["noisy", "debug", "labels"])
  })

  it("hides acted-on items and marks proposals", () => {
    const items = patternOpportunities("service_name", services)
    const debug = items.find((item) => item.reason === "debug")!
    const noisy = items.find((item) => item.reason === "noisy")!
    const rules = [createLogRule({ ...debug.rule, status: "active" }), createLogRule({ ...noisy.rule, status: "proposed" })]
    expect(rankLogOpportunities(items, rules).map((item) => [item.reason, item.state])).toEqual([["noisy", "proposed"]])
  })
})

describe("unused metrics without a dashboard scan", () => {
  it("says what was checked", () => {
    const [item] = unusedMetricOpportunities([{ metric: "big", seriesCount: 5000 }], { big: false }, { dashboardsChecked: false })
    expect(item.rulesOnly).toBe(true)
    expect(reasonLabel(item)).toBe("Not in rules")
    expect(item.rationale).toContain("dashboards weren't checked")
    const [checked] = unusedMetricOpportunities([{ metric: "big", seriesCount: 5000 }], { big: false })
    expect(reasonLabel(checked)).toBe("Unused")
  })
})
