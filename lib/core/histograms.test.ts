import { describe, expect, it } from "vitest"

import {
  bucketReductionSavings,
  classicHistograms,
  formatLe,
  histogramQuantile,
  histogramQueries,
  histogramUnit,
  nativeHistogramNames,
  nativeMigrationNotes,
  nativeSavings,
  precisionImpact,
  quantileUsage,
  roughReductionSavings,
  suggestBuckets,
  widestBand,
  type CumulativePoint,
} from "@/lib/core/histograms"
import type { MetricSummary } from "@/lib/prometheus/types"

const DEFAULT_BUCKETS = [
  ".005",
  ".01",
  ".025",
  ".05",
  ".1",
  ".25",
  ".5",
  "1",
  "2.5",
  "5",
  "10",
  "+Inf",
]

function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return x >= 0 ? y : -y
}

/** Cumulative counts of `n` log-normal observations (median, sigma) at each bound. */
function logNormal(
  les: string[],
  median: number,
  sigma: number,
  n = 1000
): CumulativePoint[] {
  return les.map((le) => {
    if (le === "+Inf") return { le, value: n }
    const z = (Math.log(Number(le)) - Math.log(median)) / sigma
    return { le, value: n * 0.5 * (1 + erf(z / Math.SQRT2)) }
  })
}

const metric = (name: string, seriesCount: number): MetricSummary => ({
  metric: name,
  seriesCount,
  percentageOfTotal: 0,
})

describe("classic histogram families", () => {
  const rows = ["0.1", "1", "+Inf"].flatMap((le) => [
    { metric: "http_seconds_bucket", le, series: 10 },
  ])
  const metrics = [
    metric("http_seconds_bucket", 30),
    metric("http_seconds_sum", 10),
    metric("http_seconds_count", 10),
    metric("token_bucket", 5),
  ]

  it("counts buckets, label sets and family series", () => {
    const [family, ...rest] = classicHistograms(
      metrics,
      [...rows, { metric: "token_bucket", le: "", series: 5 }],
      ["http_seconds"]
    )
    expect(rest).toEqual([])
    expect(family).toMatchObject({
      base: "http_seconds",
      bucketSeries: 30,
      familySeries: 50,
      les: ["0.1", "1", "+Inf"],
      labelSets: 10,
      seriesPerLabelSet: 5,
      alsoNative: true,
    })
  })

  it("falls back to bucket series / le count without _count", () => {
    const [family] = classicHistograms(
      [metric("x_bucket", 40)],
      ["1", "2", "4", "+Inf"].map((le) => ({
        metric: "x_bucket",
        le,
        series: 10,
      }))
    )
    expect(family.labelSets).toBe(10)
  })

  it("estimates native and bucket-reduction savings", () => {
    const [family] = classicHistograms(metrics, rows)
    expect(nativeSavings(family)).toMatchObject({
      seriesAfter: 10,
      saved: 40,
      estimate: true,
    })
    expect(bucketReductionSavings(family, ["1"]).saved).toBe(10)
    // +Inf is always kept, even when left out.
    expect(bucketReductionSavings(family, []).saved).toBe(20)
    expect(roughReductionSavings(family).saved).toBe(0)
  })
})

describe("histogramQuantile", () => {
  const points = [
    { le: "1", value: 10 },
    { le: "2", value: 50 },
    { le: "4", value: 100 },
    { le: "+Inf", value: 100 },
  ]

  it("interpolates like Prometheus", () => {
    expect(histogramQuantile(0.5, points)).toMatchObject({
      value: 1 + (50 - 10) / 40,
      lower: 1,
      upper: 2,
    })
    expect(histogramQuantile(0.05, points)).toMatchObject({
      value: 0.5,
      lower: 0,
      upper: 1,
    })
    expect(histogramQuantile(0.99, points)?.value).toBeCloseTo(3.96)
  })

  it("returns the top finite bound in the +Inf bucket and null without data", () => {
    expect(
      histogramQuantile(0.99, [
        { le: "1", value: 1 },
        { le: "+Inf", value: 10 },
      ])
    ).toMatchObject({ value: 1, upper: Infinity })
    expect(
      histogramQuantile(0.5, [
        { le: "1", value: 0 },
        { le: "+Inf", value: 0 },
      ])
    ).toBeNull()
  })

  it("repairs non-monotonic sums", () => {
    // "2" is lifted to 10, so rank 12 falls in +Inf.
    expect(
      histogramQuantile(0.6, [
        { le: "1", value: 10 },
        { le: "2", value: 8 },
        { le: "+Inf", value: 20 },
      ])
    ).toMatchObject({ value: 2, upper: Infinity })
  })
})

describe("suggestBuckets", () => {
  it("keeps +Inf and about six finite buckets", () => {
    const { kept, reasons } = suggestBuckets(
      DEFAULT_BUCKETS,
      logNormal(DEFAULT_BUCKETS, 0.08, 0.8)
    )
    expect(kept).toHaveLength(7)
    expect(kept.at(-1)).toBe("+Inf")
    expect(reasons["+Inf"]).toBe("inf")
  })

  it("keeps resolution where observations fall", () => {
    const points = logNormal(DEFAULT_BUCKETS, 0.08, 0.8)
    const { kept } = suggestBuckets(DEFAULT_BUCKETS, points)
    // The median (~80ms) sits in (50ms, 100ms]: both bounds survive.
    expect(kept).toContain(".05")
    expect(kept).toContain(".1")
    const [p50] = precisionImpact(points, kept) ?? []
    expect(p50.widening).toBe(1)
  })

  it("merges empty ranges first", () => {
    const les = Array.from({ length: 16 }, (_, i) =>
      String(128 * 2 ** i)
    ).concat("+Inf")
    // Every observation lands in (32768, 65536].
    const points = les.map((le) => ({
      le,
      value: le === "+Inf" || Number(le) >= 65536 ? 100 : 0,
    }))
    const { kept, fromDistribution } = suggestBuckets(les, points)
    expect(fromDistribution).toBe(true)
    expect(kept).toContain("32768")
    expect(kept).toContain("65536")
    for (const row of precisionImpact(points, kept) ?? [])
      expect(row.shift).toBe(0)
  })

  it("spaces buckets roughly evenly in log space without observations", () => {
    const les = Array.from({ length: 16 }, (_, i) => String(2 ** i)).concat(
      "+Inf"
    )
    const { kept, fromDistribution } = suggestBuckets(les)
    expect(fromDistribution).toBe(false)
    const finite = kept.filter((le) => le !== "+Inf").map(Number)
    expect(finite).toHaveLength(6)
    const gaps = finite.slice(1).map((value, i) => Math.log2(value / finite[i]))
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1)
  })

  it("keeps the bucket of a queried quantile, so it does not move", () => {
    const points = logNormal(DEFAULT_BUCKETS, 0.08, 0.8)
    const { kept, reasons } = suggestBuckets(DEFAULT_BUCKETS, points, {
      quantiles: [0.99],
    })
    const before = histogramQuantile(0.99, points)!
    expect(kept).toContain(String(before.upper).replace(/^0\./, "."))
    expect(Object.values(reasons)).toContain("quantile")
    expect(precisionImpact(points, kept, [0.99])?.[0].shift).toBe(0)
  })

  it("always keeps buckets that rules read directly", () => {
    const { kept, reasons } = suggestBuckets(DEFAULT_BUCKETS, [], {
      pinned: [".005"],
      target: 3,
    })
    expect(kept).toContain(".005")
    expect(reasons[".005"]).toBe("used")
    expect(kept).toHaveLength(4)
  })

  it("keeps everything when already small", () => {
    expect(suggestBuckets(["1", "2", "+Inf"]).kept).toEqual(["1", "2", "+Inf"])
  })
})

describe("precision impact", () => {
  it("widens the band of quantiles in merged buckets", () => {
    const points = logNormal(DEFAULT_BUCKETS, 0.08, 0.8)
    const rows = precisionImpact(points, [".01", "1", "+Inf"])!
    const p50 = rows.find((row) => row.q === 0.5)!
    expect(p50.before).toMatchObject({ lower: 0.05, upper: 0.1 })
    expect(p50.after).toMatchObject({ lower: 0.01, upper: 1 })
    expect(p50.widening).toBeCloseTo(0.99 / 0.05)
    expect(widestBand(points, [".01", "1", "+Inf"])).toMatchObject({
      lower: 0.01,
      upper: 1,
    })
  })

  it("is null without observations", () => {
    expect(
      precisionImpact(
        [
          { le: "1", value: 0 },
          { le: "+Inf", value: 0 },
        ],
        ["+Inf"]
      )
    ).toBeNull()
  })
})

describe("histogram query usage", () => {
  const rules = [
    "histogram_quantile(0.99, sum by (le) (rate(http_seconds_bucket[5m]))) > 1",
    'sum(rate(http_seconds_bucket{le="0.5"}[5m])) / sum(rate(http_seconds_count[5m]))',
    "histogram_quantile(0.5, rate(http_seconds_bucket_other[5m]))",
  ]

  it("finds quantiles and literal le values per metric", () => {
    expect(quantileUsage(rules, "http_seconds_bucket")).toEqual({
      quantiles: [0.99],
      les: ["0.5"],
    })
    expect(quantileUsage(rules, "http_seconds_bucket_other")).toEqual({
      quantiles: [0.5],
      les: [],
    })
  })
})

describe("native histogram detection", () => {
  it("reads counted names and raw histogram samples", () => {
    expect(
      nativeHistogramNames([
        { metric: { cardinal_metric: "rpc_seconds" }, value: [0, "3"] },
        {
          metric: { __name__: "db_seconds", job: "a" },
          histogram: [0, { count: "1" }],
        },
        {
          metric: { __name__: "db_seconds", job: "b" },
          histogram: [0, { count: "1" }],
        },
        { metric: { __name__: "plain" }, value: [0, "1"] },
      ])
    ).toEqual([
      { metric: "rpc_seconds", series: 3 },
      { metric: "db_seconds", series: 2 },
    ])
  })

  it("builds safe queries", () => {
    expect(
      histogramQueries.distribution({
        metric: "x_bucket",
        matchers: { job: 'a"b' },
      })
    ).toBe('sum by (le) (rate({__name__="x_bucket",job="a\\"b"}[1h]))')
    expect(() =>
      histogramQueries.distribution({ metric: "x_bucket" }, "1h]) or vector(1")
    ).toThrow()
    expect(() => histogramQueries.leForMetric({ metric: "bad name" })).toThrow()
  })
})

describe("histogram display", () => {
  it("formats bounds by unit", () => {
    expect(histogramUnit("http_request_duration_seconds")).toBe("seconds")
    expect(formatLe("0.25", "seconds")).toBe("250ms")
    expect(formatLe("1.048576e+06", "bytes")).toBe("1MiB")
    expect(formatLe("+Inf", "bytes")).toBe("+Inf")
    expect(formatLe("15000")).toBe("15k")
  })

  it("writes migration notes with hedged settings", () => {
    const notes = nativeMigrationNotes(
      {
        base: "http_seconds",
        les: DEFAULT_BUCKETS,
        labelSets: 10,
        familySeries: 140,
      },
      ["api"]
    )
    expect(notes).toContain("NativeHistogramBucketFactor")
    expect(notes).toContain("scrape_native_histograms")
    expect(notes).toContain("--enable-feature=native-histograms")
    expect(notes).toContain("base2_exponential_bucket_histogram")
    expect(notes).toContain("an estimated 130 fewer")
  })
})
