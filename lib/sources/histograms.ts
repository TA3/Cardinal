import { runWithConcurrency } from "@/lib/core/concurrency"
import {
  bucketReductionSavings,
  bucketSelector,
  classicHistograms,
  histogramQueries,
  nativeHistogramNames,
  nativeSavings,
  precisionImpact,
  quantileUsage,
  suggestBuckets,
  widestBand,
  type ClassicHistogram,
  type CumulativePoint,
  type LeRow,
  type QuantileUsage,
} from "@/lib/core/histograms"
import type { MetricSummary, PrometheusResponse } from "@/lib/prometheus/types"
import { isQueryLimitError } from "@/lib/sources/prometheus"
import { sendJson, type Connection } from "@/lib/sources/transport"

// Histogram queries: `le` counts for every `_bucket` metric, one family's
// bucket distribution, native histograms already in use, and the quantiles
// that alerting/recording rules ask for.

interface Sample {
  metric: Record<string, string>
  value?: [number, string]
  histogram?: [number, unknown]
}

async function instant(
  connection: Connection,
  query: string,
  signal?: AbortSignal
) {
  const payload = await sendJson<PrometheusResponse<{ result: Sample[] }>>(
    connection,
    {
      path: "/api/v1/query",
      query: { query },
      signal,
    }
  )
  if (payload.status !== "success" || !payload.data)
    throw new Error(payload.error ?? "Prometheus API returned an error")
  return payload.data.result
}

const number = (sample: Sample) => {
  const value = Number(sample.value?.[1])
  return Number.isFinite(value) ? value : 0
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

/** Families the per-metric fallback covers when the combined `le` query is too large. */
const FALLBACK_FAMILIES = 60

/**
 * Series per `le` for every `_bucket` metric: one `count by (__name__, le)`,
 * or, when that hits a query limit, one `count by (le)` per bucket metric for
 * the largest ones in the snapshot.
 */
export async function fetchLeRows(
  connection: Connection,
  metrics: MetricSummary[],
  signal?: AbortSignal
): Promise<{ rows: LeRow[]; partial: boolean }> {
  try {
    const result = await instant(
      connection,
      histogramQueries.leByBucketMetric(),
      signal
    )
    return {
      rows: result.map((row) => ({
        metric: row.metric.__name__ ?? "",
        le: row.metric.le ?? "",
        series: number(row),
      })),
      partial: false,
    }
  } catch (error) {
    if (isAbort(error) || !isQueryLimitError(error)) throw error
    const candidates = metrics
      .filter((item) => item.metric.endsWith("_bucket"))
      .slice(0, FALLBACK_FAMILIES)
    const perMetric = await runWithConcurrency(
      candidates,
      async (item) => {
        const result = await instant(
          connection,
          histogramQueries.leForMetric(bucketSelector(item.metric)),
          signal
        ).catch((inner: unknown) => {
          if (isAbort(inner)) throw inner
          return []
        })
        return result.map((row) => ({
          metric: item.metric,
          le: row.metric.le ?? "",
          series: number(row),
        }))
      },
      4,
      signal
    )
    return { rows: perMetric.flat(), partial: true }
  }
}

/** One family from a single `count by (le)`, for the metric page. Null when the metric has no `le` values. */
export async function fetchClassicHistogram(
  connection: Connection,
  metrics: MetricSummary[],
  bucketMetric: string,
  signal?: AbortSignal
) {
  const result = await instant(
    connection,
    histogramQueries.leForMetric(bucketSelector(bucketMetric)),
    signal
  )
  const rows = result.map((row) => ({
    metric: bucketMetric,
    le: row.metric.le ?? "",
    series: number(row),
  }))
  return classicHistograms(metrics, rows)[0] ?? null
}

export interface NativeHistogramUse {
  metric: string
  series: number
}

/**
 * Metrics already stored as native histograms. Counts every non-suffixed
 * series once, so it can hit query limits on big tenants: callers treat a
 * failure as "unknown", not "none".
 */
export async function fetchNativeHistograms(
  connection: Connection,
  signal?: AbortSignal
): Promise<NativeHistogramUse[]> {
  return nativeHistogramNames(
    await instant(connection, histogramQueries.nativeHistograms(), signal)
  )
}

export interface BucketDistribution {
  points: CumulativePoint[]
  /** "rate": observations per second over the last hour; "lifetime": raw counters (no traffic in the last hour). */
  source: "rate" | "lifetime"
  total: number
}

/** Cumulative observations per `le`: the last hour's rate, else raw counters when that hour saw nothing. */
export async function fetchBucketDistribution(
  connection: Connection,
  bucketMetric: string,
  options: { job?: string; signal?: AbortSignal } = {}
): Promise<BucketDistribution> {
  const sel = bucketSelector(bucketMetric, options.job)
  const read = async (query: string) => {
    const result = await instant(connection, query, options.signal)
    const points = result
      .filter((row) => row.metric.le)
      .map((row) => ({ le: row.metric.le, value: number(row) }))
    const total = points.find((point) => point.le === "+Inf")?.value ?? 0
    return { points, total }
  }
  const rate = await read(histogramQueries.distribution(sel, "1h"))
  if (rate.total > 0) return { ...rate, source: "rate" }
  return {
    ...(await read(histogramQueries.lifetimeDistribution(sel))),
    source: "lifetime",
  }
}

interface RulesResponse {
  groups: Array<{ rules: Array<{ query: string }> }>
}

/** Every alerting/recording rule expression, for quantileUsage. Empty when the rules API is unavailable. */
export async function fetchRuleQueries(
  connection: Connection,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const payload = await sendJson<PrometheusResponse<RulesResponse>>(
      connection,
      { path: "/api/v1/rules", signal }
    )
    return (
      payload.data?.groups.flatMap((group) =>
        group.rules.map((rule) => rule.query)
      ) ?? []
    )
  } catch (error) {
    if (isAbort(error)) throw error
    return []
  }
}

export interface HistogramAnalysis {
  families: ClassicHistogram[]
  native: NativeHistogramUse[] | null
  /** The `le` counts came from per-metric queries for the largest families only. */
  partial: boolean
}

/** Classic families from the snapshot plus `le` rows, with native use when it can be checked. */
export async function fetchHistogramAnalysis(
  connection: Connection,
  metrics: MetricSummary[],
  signal?: AbortSignal
): Promise<HistogramAnalysis> {
  const [le, native] = await Promise.all([
    fetchLeRows(connection, metrics, signal),
    fetchNativeHistograms(connection, signal).catch((error: unknown) => {
      if (isAbort(error)) throw error
      return null
    }),
  ])
  return {
    families: classicHistograms(
      metrics,
      le.rows,
      native?.map((item) => item.metric)
    ),
    native,
    partial: le.partial,
  }
}

export interface FamilyPlan {
  family: ClassicHistogram
  distribution: BucketDistribution | null
  usage: QuantileUsage
  suggestion: ReturnType<typeof suggestBuckets>
}

/** A family's suggested `le` set from its distribution and the quantiles its rules use. */
export function planFamily(
  family: ClassicHistogram,
  distribution: BucketDistribution | null,
  usage: QuantileUsage,
  target?: number
): FamilyPlan {
  return {
    family,
    distribution,
    usage,
    suggestion: suggestBuckets(family.les, distribution?.points ?? [], {
      target,
      quantiles: usage.quantiles,
      pinned: usage.les,
    }),
  }
}

/** Compact per-family result for the agent tool. */
export function describePlan({
  family,
  distribution,
  usage,
  suggestion,
}: FamilyPlan) {
  const native = nativeSavings(family)
  const reduction = bucketReductionSavings(family, suggestion.kept)
  const precision = distribution
    ? precisionImpact(
        distribution.points,
        suggestion.kept,
        usage.quantiles.length ? usage.quantiles : undefined
      )
    : null
  const band = distribution
    ? widestBand(distribution.points, suggestion.kept)
    : null
  return {
    family: family.base,
    bucket_metric: family.bucketMetric,
    bucket_series: family.bucketSeries,
    family_series: family.familySeries,
    le_count: family.les.length,
    label_sets: family.labelSets,
    already_native: family.alsoNative || undefined,
    queried_quantiles: usage.quantiles.length ? usage.quantiles : undefined,
    rule_le_values: usage.les.length ? usage.les : undefined,
    suggested_le: suggestion.kept,
    suggestion_basis: suggestion.fromDistribution
      ? `observed distribution (${distribution?.source === "lifetime" ? "lifetime counters" : "last hour"})`
      : "log spacing (no observations)",
    estimated_savings: {
      bucket_reduction_series: reduction.saved,
      native_histogram_series: native.saved,
    },
    precision: precision?.map((row) => ({
      quantile: row.q,
      before: {
        estimate: round(row.before.value),
        band: [round(row.before.lower), round(row.before.upper)],
      },
      after: {
        estimate: round(row.after.value),
        band: [round(row.after.lower), round(row.after.upper)],
      },
    })),
    widest_error_band: band
      ? [round(band.lower), round(band.upper)]
      : undefined,
  }
}

function round(value: number) {
  return Number.isFinite(value)
    ? Number(value.toPrecision(4))
    : value > 0
      ? "+Inf"
      : "-Inf"
}

/** The get_histograms agent tool: the largest families with suggested `le` sets and both savings estimates. */
export async function histogramReport(
  connection: Connection,
  metrics: MetricSummary[],
  options: { limit: number; totalSeries: number; signal?: AbortSignal }
) {
  const [analysis, ruleQueries] = await Promise.all([
    fetchHistogramAnalysis(connection, metrics, options.signal),
    fetchRuleQueries(connection, options.signal),
  ])
  const top = analysis.families.slice(0, options.limit)
  const plans = await runWithConcurrency(
    top,
    async (family) => {
      const distribution = await fetchBucketDistribution(
        connection,
        family.bucketMetric,
        { signal: options.signal }
      ).catch((error: unknown) => {
        if (isAbort(error)) throw error
        return null
      })
      return describePlan(
        planFamily(
          family,
          distribution,
          quantileUsage(ruleQueries, family.bucketMetric)
        )
      )
    },
    4,
    options.signal
  )
  const pct = (part: number) =>
    options.totalSeries > 0
      ? Number(((part / options.totalSeries) * 100).toFixed(2))
      : 0
  const familySeries = analysis.families.reduce(
    (sum, family) => sum + family.familySeries,
    0
  )
  return {
    classic_families: analysis.families.length,
    histogram_series: familySeries,
    histogram_percent_of_total: pct(familySeries),
    families: plans,
    already_native:
      analysis.native === null
        ? "unknown (the check hit a query limit)"
        : analysis.native,
    partial: analysis.partial || undefined,
    notes: [
      "Savings are estimates. bucket_reduction_series assumes a keep_buckets relabel rule with suggested_le (+Inf always kept); the user can propose it from Cardinal's Histograms page.",
      "native_histogram_series assumes about one series per label set after migrating. It needs Prometheus >= 2.40 with native histograms enabled (feature flag, or scrape_native_histograms in newer 3.x) or OTel exponential histograms, client library support, protobuf scraping, and query changes (histogram_quantile on the native series). Grafana Cloud may bill native histograms differently; hedge any cost claims.",
      "precision bands: the true quantile lies somewhere in the band; histogram_quantile interpolates linearly within it.",
    ],
  }
}
