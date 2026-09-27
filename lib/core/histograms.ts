import { familyMembers, histogramFamily } from "@/lib/core/families"
import {
  assertMetricName,
  selector,
  type SeriesSelector,
} from "@/lib/core/promql"
import { INF_BUCKET, normalizeBuckets } from "@/lib/core/rules"
import type { MetricSummary } from "@/lib/prometheus/types"

// Classic histogram analysis: bucket counts per family, a reduced `le` set that
// keeps resolution where observations fall, the precision it costs, and a
// rough native-histogram estimate. Every saving here is an estimate.

/** Series per `le` value of one `_bucket` metric. */
export interface LeRow {
  metric: string
  le: string
  series: number
}

export interface ClassicHistogram {
  base: string
  bucketMetric: string
  bucketSeries: number
  sumSeries: number
  countSeries: number
  /** `_bucket` + `_sum` + `_count` series. */
  familySeries: number
  /** Distinct `le` values, sorted, `+Inf` last. */
  les: string[]
  /** Bucket series per `le`. */
  seriesByLe: Record<string, number>
  /** Distinct label sets (one histogram each): `_count` series, else bucket series / le count. */
  labelSets: number
  /** Series one label set costs today: le count + 2. */
  seriesPerLabelSet: number
  /** The base name also has native histogram samples (classic and native scraped side by side). */
  alsoNative: boolean
}

/** Finite `le` values kept by default, besides `+Inf`. */
export const DEFAULT_KEEP = 6
/** Reference quantiles for the precision report when none are known from queries. */
export const DEFAULT_QUANTILES = [0.5, 0.9, 0.99]

export function parseLe(le: string) {
  if (le === INF_BUCKET || le === "+inf" || le === "Inf") return Infinity
  const value = Number(le)
  return Number.isNaN(value) ? NaN : value
}

/** Sorts `le` values numerically with `+Inf` last, without adding one. */
export function sortLes(les: Iterable<string>) {
  const values = new Set(les)
  const hasInf = values.has(INF_BUCKET)
  const sorted = normalizeBuckets(values)
  return hasInf ? sorted : sorted.filter((le) => le !== INF_BUCKET)
}

/**
 * Classic histogram families from the snapshot plus `count by (__name__, le)`
 * rows for `_bucket` metrics. A `_bucket` metric without `le` values is not a
 * histogram and is skipped. Sorted by bucket series, largest first.
 */
export function classicHistograms(
  metrics: MetricSummary[],
  rows: LeRow[],
  nativeNames: Iterable<string> = []
): ClassicHistogram[] {
  const series = new Map(metrics.map((item) => [item.metric, item.seriesCount]))
  const native = new Set(nativeNames)
  const byMetric = new Map<string, Map<string, number>>()
  for (const row of rows) {
    if (!row.le) continue
    const perLe = byMetric.get(row.metric) ?? new Map<string, number>()
    perLe.set(row.le, (perLe.get(row.le) ?? 0) + row.series)
    byMetric.set(row.metric, perLe)
  }
  const snapshot = { metrics }
  const families: ClassicHistogram[] = []
  for (const [bucketMetric, perLe] of byMetric) {
    const { base, part } = histogramFamily(bucketMetric)
    if (part !== "bucket") continue
    const members = new Set(familyMembers(base, snapshot))
    const count = (name: string) =>
      members.has(name) ? (series.get(name) ?? 0) : 0
    const les = sortLes(perLe.keys())
    const bucketSeries =
      series.get(bucketMetric) ??
      Array.from(perLe.values()).reduce((sum, value) => sum + value, 0)
    const sumSeries = count(`${base}_sum`)
    const countSeries = count(`${base}_count`)
    const labelSets =
      countSeries > 0
        ? countSeries
        : Math.max(1, Math.round(bucketSeries / Math.max(1, les.length)))
    families.push({
      base,
      bucketMetric,
      bucketSeries,
      sumSeries,
      countSeries,
      familySeries: bucketSeries + sumSeries + countSeries,
      les,
      seriesByLe: Object.fromEntries(les.map((le) => [le, perLe.get(le) ?? 0])),
      labelSets,
      seriesPerLabelSet: les.length + 2,
      alsoNative: native.has(base),
    })
  }
  return families.sort(
    (a, b) => b.bucketSeries - a.bucketSeries || a.base.localeCompare(b.base)
  )
}

export interface SavingsEstimate {
  seriesBefore: number
  seriesAfter: number
  saved: number
  /** Always true: these are projections, not measurements. */
  estimate: true
}

/**
 * Native histogram migration: about one series per label set replaces the
 * `le` count + 2 classic series. Real numbers depend on the backend (and
 * billing may weigh native histograms differently).
 */
export function nativeSavings(
  family: Pick<ClassicHistogram, "familySeries" | "labelSets">
): SavingsEstimate {
  const seriesAfter = Math.min(family.familySeries, family.labelSets)
  return {
    seriesBefore: family.familySeries,
    seriesAfter,
    saved: family.familySeries - seriesAfter,
    estimate: true,
  }
}

/** Keeping `kept` of the `le` values: each label set loses the dropped bucket series. */
export function bucketReductionSavings(
  family: Pick<ClassicHistogram, "bucketSeries" | "les" | "seriesByLe">,
  kept: Iterable<string>
): SavingsEstimate {
  const keep = new Set(kept)
  keep.add(INF_BUCKET)
  const dropped = family.les
    .filter((le) => !keep.has(le))
    .reduce((sum, le) => sum + (family.seriesByLe[le] ?? 0), 0)
  return {
    seriesBefore: family.bucketSeries,
    seriesAfter: family.bucketSeries - dropped,
    saved: dropped,
    estimate: true,
  }
}

/** Buckets a default reduction keeps: DEFAULT_KEEP finite ones plus `+Inf`. */
export function defaultKeepCount(les: string[], target = DEFAULT_KEEP) {
  const finite = les.filter((le) => Number.isFinite(parseLe(le))).length
  return Math.min(finite, target) + (les.includes(INF_BUCKET) ? 1 : 0)
}

/** Saving of a default reduction before the distribution is known: drops the smallest buckets by series. */
export function roughReductionSavings(
  family: Pick<ClassicHistogram, "bucketSeries" | "les" | "seriesByLe">,
  target = DEFAULT_KEEP
) {
  const finite = family.les.filter((le) => Number.isFinite(parseLe(le)))
  if (finite.length <= target) return bucketReductionSavings(family, family.les)
  // Assume the dropped buckets are average-sized.
  const perLe = family.bucketSeries / Math.max(1, family.les.length)
  const saved = Math.round(perLe * (finite.length - target))
  const estimate: SavingsEstimate = {
    seriesBefore: family.bucketSeries,
    seriesAfter: family.bucketSeries - saved,
    saved,
    estimate: true,
  }
  return estimate
}

// ---- Distribution, quantiles and the reduced `le` set ----

/** Cumulative count (or rate) at one `le`, as `sum by (le) (rate(x_bucket[1h]))` returns it. */
export interface CumulativePoint {
  le: string
  value: number
}

interface Bucket {
  le: string
  upper: number
  cumulative: number
}

/**
 * Sorted buckets with a monotonic cumulative count. Counter resets and
 * scrapes of different targets can make raw sums dip, so each value is at
 * least the one before it.
 */
export function toBuckets(points: CumulativePoint[]): Bucket[] {
  const byLe = new Map(points.map((point) => [point.le, point.value]))
  let running = 0
  return sortLes(byLe.keys())
    .map((le) => ({ le, upper: parseLe(le), raw: byLe.get(le) ?? 0 }))
    .filter((bucket) => !Number.isNaN(bucket.upper))
    .map(({ le, upper, raw }) => {
      running = Math.max(running, Number.isFinite(raw) ? raw : 0)
      return { le, upper, cumulative: running }
    })
}

/** Observations per bucket (non-cumulative), in `le` order. */
export function bucketMass(points: CumulativePoint[]) {
  const buckets = toBuckets(points)
  return buckets.map((bucket, index) => ({
    le: bucket.le,
    value: bucket.cumulative - (index ? buckets[index - 1].cumulative : 0),
  }))
}

export interface QuantileEstimate {
  q: number
  /** histogram_quantile's answer. */
  value: number
  /** The bucket it falls in: the true quantile is somewhere in (lower, upper]. */
  lower: number
  upper: number
}

/**
 * histogram_quantile semantics: linear interpolation in the bucket where the
 * rank falls; the first bucket starts at 0 (when its bound is positive); a
 * rank in the +Inf bucket returns the highest finite bound. Null without
 * observations.
 */
export function histogramQuantile(
  q: number,
  points: CumulativePoint[]
): QuantileEstimate | null {
  const buckets = toBuckets(points)
  if (buckets.length < 2 || buckets[buckets.length - 1].upper !== Infinity)
    return null
  const total = buckets[buckets.length - 1].cumulative
  if (!(total > 0) || !(q >= 0 && q <= 1)) return null
  const rank = q * total
  const index = buckets.findIndex((bucket) => bucket.cumulative >= rank)
  const bucket = buckets[index]
  if (bucket.upper === Infinity) {
    const top = buckets[buckets.length - 2].upper
    return { q, value: top, lower: top, upper: Infinity }
  }
  if (index === 0 && bucket.upper <= 0)
    return { q, value: bucket.upper, lower: -Infinity, upper: bucket.upper }
  const lower = index === 0 ? 0 : buckets[index - 1].upper
  const below = index === 0 ? 0 : buckets[index - 1].cumulative
  const inside = bucket.cumulative - below
  const value =
    inside > 0
      ? lower + (bucket.upper - lower) * ((rank - below) / inside)
      : bucket.upper
  return { q, value, lower, upper: bucket.upper }
}

export type KeepReason = "inf" | "used" | "quantile" | "distribution"

export interface BucketSuggestion {
  /** The `le` values to keep, sorted, `+Inf` included. */
  kept: string[]
  /** Why each kept value is there. */
  reasons: Record<string, KeepReason>
  /** True when the pick used observed counts; false means log spacing only. */
  fromDistribution: boolean
}

export interface SuggestOptions {
  /** Finite buckets to keep (default 6); pinned buckets may push it higher. */
  target?: number
  /** Quantiles known to be queried: the buckets around them are kept as they are. */
  quantiles?: number[]
  /** `le` values referenced directly (e.g. `le="0.5"` in an SLO rule): always kept. */
  pinned?: string[]
}

/**
 * Proposes a reduced `le` set. Starting from every bucket, it repeatedly drops
 * the boundary whose removal costs least, where a bucket costs
 * (share of observations + ε) × width² in log space (linear when bounds are
 * ≤ 0), plus width² for each reference quantile's bucket. Empty regions merge
 * first, busy buckets and the quantiles keep their resolution, and without
 * observations the ε term leaves roughly log-spaced buckets. `+Inf`, pinned
 * values and the bounds of queried quantiles' buckets are never dropped.
 */
export function suggestBuckets(
  les: string[],
  points: CumulativePoint[] = [],
  options: SuggestOptions = {}
): BucketSuggestion {
  const target = Math.max(1, Math.floor(options.target ?? DEFAULT_KEEP))
  const sorted = sortLes(les).filter((le) => !Number.isNaN(parseLe(le)))
  const finite = sorted.filter((le) => Number.isFinite(parseLe(le)))
  const reasons: Record<string, KeepReason> = {}
  if (sorted.includes(INF_BUCKET)) reasons[INF_BUCKET] = "inf"

  const values = new Map(points.map((point) => [point.le, point.value]))
  const buckets = toBuckets(
    sorted.map((le) => ({ le, value: values.get(le) ?? 0 }))
  )
  const cumulative = new Map(
    buckets.map((bucket) => [bucket.le, bucket.cumulative])
  )
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0
  const hasData = total > 0 && sorted.includes(INF_BUCKET)

  for (const le of options.pinned ?? [])
    if (finite.includes(le)) reasons[le] = "used"
  const quantiles = options.quantiles?.length ? options.quantiles : []
  const reference = hasData
    ? quantiles.length
      ? quantiles
      : DEFAULT_QUANTILES
    : []
  if (hasData) {
    for (const q of quantiles) {
      const index = finite.findIndex(
        (le) => (cumulative.get(le) ?? 0) >= q * total
      )
      // The bucket holding q: its upper and lower bound stay, so the quantile is unchanged.
      for (const i of index === -1 ? [finite.length - 1] : [index - 1, index]) {
        const le = finite[i]
        if (le !== undefined && !reasons[le]) reasons[le] = "quantile"
      }
    }
  }

  if (finite.length <= target) {
    for (const le of finite) reasons[le] ??= "distribution"
    return { kept: sorted, reasons, fromDistribution: hasData }
  }

  const numbers = finite.map(parseLe)
  const logScale = numbers.every((value) => value > 0)
  const pos = (value: number) => (logScale ? Math.log(value) : value)
  const first = pos(numbers[0])
  const step = numbers.length > 1 ? pos(numbers[1]) - first : 1
  const lowerPos = first - (step > 0 ? step : 1)
  const span = pos(numbers[numbers.length - 1]) - lowerPos || 1
  // The +Inf bucket counts as one more step above the top bound.
  const topStep =
    numbers.length > 1
      ? pos(numbers[numbers.length - 1]) - pos(numbers[numbers.length - 2])
      : 1
  const upperPos =
    pos(numbers[numbers.length - 1]) + (topStep > 0 ? topStep : 1)
  const epsilon = 0.05
  const cumAt = (index: number) =>
    index < 0 ? 0 : (cumulative.get(finite[index]) ?? 0)

  // Cost of keeping the finite boundaries at `kept` (indices into `finite`).
  const cost = (kept: number[]) => {
    let sum = 0
    let prevPos = lowerPos
    let prevCum = 0
    const bounds = [...kept, -1]
    for (const index of bounds) {
      const upper = index === -1 ? upperPos : pos(numbers[index])
      const cum = index === -1 ? total : cumAt(index)
      const width = (upper - prevPos) / span
      const share = hasData ? (cum - prevCum) / total : 0
      sum += (share + epsilon) * width * width
      for (const q of reference) {
        const rank = q * total
        if (rank > prevCum && rank <= cum) sum += width * width
      }
      prevPos = upper
      prevCum = cum
    }
    return sum
  }

  let kept = finite.map((_, index) => index)
  const locked = (index: number) => Boolean(reasons[finite[index]])
  while (kept.length > target) {
    let best = -1
    let bestCost = Infinity
    for (let i = 0; i < kept.length; i++) {
      if (locked(kept[i])) continue
      const next = kept.filter((_, j) => j !== i)
      const value = cost(next)
      if (value < bestCost - 1e-12) {
        bestCost = value
        best = i
      }
    }
    if (best === -1) break
    kept = kept.filter((_, j) => j !== best)
  }
  for (const index of kept) reasons[finite[index]] ??= "distribution"
  const keptSet = new Set(kept.map((index) => finite[index]))
  return {
    kept: sorted.filter((le) => le === INF_BUCKET || keptSet.has(le)),
    reasons: Object.fromEntries(
      Object.entries(reasons).filter(
        ([le]) => le === INF_BUCKET || keptSet.has(le)
      )
    ),
    fromDistribution: hasData,
  }
}

export interface PrecisionRow {
  q: number
  before: QuantileEstimate
  after: QuantileEstimate
  /** after.value relative to before.value, e.g. 0.12 = 12% higher. Null when before is 0 or infinite. */
  shift: number | null
  /** Width of the bucket the quantile falls in after the reduction, relative to before (≥ 1). */
  widening: number
}

/**
 * What a reduced `le` set does to quantiles: for each q, the bucket the true
 * value lies in (the error band) before and after, and how far
 * histogram_quantile's estimate moves. Null without observations.
 */
export function precisionImpact(
  points: CumulativePoint[],
  kept: string[],
  quantiles: number[] = DEFAULT_QUANTILES
): PrecisionRow[] | null {
  const keep = new Set(kept)
  keep.add(INF_BUCKET)
  const reduced = points.filter((point) => keep.has(point.le))
  const rows: PrecisionRow[] = []
  for (const q of quantiles) {
    const before = histogramQuantile(q, points)
    const after = histogramQuantile(q, reduced)
    if (!before || !after) return null
    const widthBefore = before.upper - before.lower
    const widthAfter = after.upper - after.lower
    const widening =
      Number.isFinite(widthBefore) && widthBefore > 0
        ? widthAfter / widthBefore
        : widthAfter === widthBefore
          ? 1
          : Infinity
    rows.push({
      q,
      before,
      after,
      shift:
        before.value !== 0 && Number.isFinite(before.value)
          ? after.value / before.value - 1
          : null,
      widening,
    })
  }
  return rows
}

/**
 * The widest error band left among kept buckets holding at least 0.1% of
 * observations: a quantile in (lower, upper] can be anywhere in it. Measured
 * as upper / lower, so the first bucket (lower bound 0) is skipped.
 */
export function widestBand(points: CumulativePoint[], kept: string[]) {
  const keep = new Set(kept)
  keep.add(INF_BUCKET)
  const buckets = toBuckets(points.filter((point) => keep.has(point.le)))
  let widest: { lower: number; upper: number; share: number } | null = null
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0
  if (!(total > 0)) return null
  for (let i = 0; i < buckets.length; i++) {
    const lower = i === 0 ? 0 : buckets[i - 1].upper
    const upper = buckets[i].upper
    const share =
      (buckets[i].cumulative - (i === 0 ? 0 : buckets[i - 1].cumulative)) /
      total
    if (share < 0.001 || !Number.isFinite(upper) || !(lower > 0)) continue
    if (!widest || upper / lower > widest.upper / widest.lower)
      widest = { lower, upper, share }
  }
  return widest
}

// ---- Usage in queries ----

export interface QuantileUsage {
  quantiles: number[]
  /** `le` values matched literally, e.g. `x_bucket{le="0.5"}` in an SLO. */
  les: string[]
}

const QUANTILE_CALL = /histogram_quantile\s*\(\s*([0-9.eE+-]+)\s*,/g
const LE_MATCHER = /\ble\s*=\s*"([^"]+)"/g

function mentions(query: string, metric: string) {
  return new RegExp(
    `(^|[^a-zA-Z0-9_:])${metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-zA-Z0-9_:])`
  ).test(query)
}

/**
 * Quantiles and literal `le` values that queries use for `bucketMetric`. A
 * query counts when it mentions the metric; its histogram_quantile calls give
 * the quantiles (a rough attribution when one query covers several metrics).
 */
export function quantileUsage(
  queryTexts: string[],
  bucketMetric: string
): QuantileUsage {
  const quantiles = new Set<number>()
  const les = new Set<string>()
  for (const query of queryTexts) {
    if (!mentions(query, bucketMetric)) continue
    for (const match of query.matchAll(QUANTILE_CALL)) {
      const q = Number(match[1])
      if (q > 0 && q < 1) quantiles.add(q)
    }
    for (const match of query.matchAll(LE_MATCHER)) les.add(match[1])
  }
  return {
    quantiles: Array.from(quantiles).sort((a, b) => a - b),
    les: sortLes(les),
  }
}

// ---- Queries ----

/** Metric-name label used to keep names through functions that drop `__name__`. */
export const NAME_LABEL = "cardinal_metric"

export const histogramQueries = {
  /** Series per (bucket metric, le) for every `_bucket` metric at once. */
  leByBucketMetric: () => 'count by (__name__, le) ({__name__=~".+_bucket"})',
  /** Series per le for one bucket metric (fallback when the combined query is too large). */
  leForMetric: (sel: SeriesSelector) => `count by (le) (${selector(sel)})`,
  /** Cumulative observation rate per le over `window` (e.g. "1h"). */
  distribution: (sel: SeriesSelector, window = "1h") => {
    if (!/^[0-9]+[smhdw]$/.test(window))
      throw new Error(`Invalid range: ${window}`)
    return `sum by (le) (rate(${selector(sel)}[${window}]))`
  },
  /** Cumulative counts since each process started (no traffic in the window). */
  lifetimeDistribution: (sel: SeriesSelector) =>
    `sum by (le) (${selector(sel)})`,
  /**
   * Series with native histogram samples, per metric name. histogram_count
   * ignores float samples and drops `__name__`, so the name is copied first.
   */
  nativeHistograms: () =>
    `count by (${NAME_LABEL}) (histogram_count(label_replace({__name__=~".+",__name__!~".+_(bucket|sum|count|total|created|info)"}, "${NAME_LABEL}", "$1", "__name__", "(.+)")))`,
}

interface Sample {
  metric: Record<string, string>
  value?: [number, string]
  histogram?: [number, unknown]
}

/**
 * Metric names with native histograms from an instant query result: rows of
 * the nativeHistograms count (name in NAME_LABEL), or raw samples that carry a
 * `histogram` field instead of `value`.
 */
export function nativeHistogramNames(result: Sample[]) {
  const counts = new Map<string, number>()
  for (const row of result) {
    const counted = row.metric[NAME_LABEL]
    if (counted && row.value)
      counts.set(
        counted,
        (counts.get(counted) ?? 0) + (Number(row.value[1]) || 0)
      )
    else if (row.histogram && row.metric.__name__)
      counts.set(
        row.metric.__name__,
        (counts.get(row.metric.__name__) ?? 0) + 1
      )
  }
  return Array.from(counts, ([metric, series]) => ({ metric, series })).sort(
    (a, b) => b.series - a.series || a.metric.localeCompare(b.metric)
  )
}

/** Validates and returns the selector for a family's bucket metric. */
export function bucketSelector(
  bucketMetric: string,
  job?: string
): SeriesSelector {
  assertMetricName(bucketMetric)
  return job === undefined
    ? { metric: bucketMetric }
    : { metric: bucketMetric, matchers: { job } }
}

// ---- Display ----

export type HistogramUnit = "seconds" | "bytes" | "none"

export function histogramUnit(base: string): HistogramUnit {
  if (/_seconds$/.test(base)) return "seconds"
  if (/_bytes$|_size$|_sizes$/.test(base)) return "bytes"
  return "none"
}

function trim(value: number, digits = 3) {
  return Number(value.toPrecision(digits)).toString()
}

/** `le` bound for people: "250ms", "64KiB", "1.2M"; "+Inf" stays. */
export function formatBound(value: number, unit: HistogramUnit = "none") {
  if (value === Infinity) return INF_BUCKET
  if (value === -Infinity) return "−Inf"
  if (unit === "seconds") {
    const abs = Math.abs(value)
    if (abs === 0) return "0s"
    if (abs < 1e-3) return `${trim(value * 1e6)}µs`
    if (abs < 1) return `${trim(value * 1e3)}ms`
    if (abs < 120) return `${trim(value)}s`
    if (abs < 7200) return `${trim(value / 60)}m`
    return `${trim(value / 3600)}h`
  }
  if (unit === "bytes") {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    let scaled = value
    let index = 0
    while (Math.abs(scaled) >= 1024 && index < units.length - 1) {
      scaled /= 1024
      index += 1
    }
    return `${trim(scaled)}${units[index]}`
  }
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trim(value / 1e9)}G`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e4) return `${trim(value / 1e3)}k`
  return trim(value, 4)
}

export function formatLe(le: string, unit: HistogramUnit = "none") {
  const value = parseLe(le)
  return Number.isNaN(value) ? le : formatBound(value, unit)
}

export function formatQuantile(q: number) {
  return `p${trim(q * 100, 4)}`
}

// ---- Migration notes ----

/**
 * Short markdown for a service owner moving `family` to native histograms.
 * Names are current as of Prometheus 3.x / client_golang 1.x /
 * client_java 1.x; the notes say where to double-check.
 */
export function nativeMigrationNotes(
  family: Pick<ClassicHistogram, "base" | "les" | "labelSets" | "familySeries">,
  jobs: string[] = []
) {
  const saving = nativeSavings(family)
  const jobText = jobs.length
    ? ` (job${jobs.length === 1 ? "" : "s"} ${jobs
        .slice(0, 5)
        .map((job) => `\`${job || "(no job)"}\``)
        .join(", ")})`
    : ""
  return `## Migrate \`${family.base}\` to a native histogram

\`${family.base}\`${jobText} is a classic histogram with ${family.les.length} buckets: about ${family.familySeries.toLocaleString("en-US")} active series across ${family.labelSets.toLocaleString("en-US")} label sets. As a native histogram it would be roughly ${saving.seriesAfter.toLocaleString("en-US")} series (one per label set), an estimated ${saving.saved.toLocaleString("en-US")} fewer. Treat that as an estimate: check how your backend counts and bills native histograms before relying on it.

### 1. Instrumentation

Native histograms are only exposed over the protobuf exposition format (or OTLP), so the scraper must negotiate it.

- **Go (client_golang ≥ 1.14):** set \`NativeHistogramBucketFactor\` (e.g. \`1.1\`) in \`prometheus.HistogramOpts\`; optionally \`NativeHistogramMaxBucketNumber\` (e.g. \`100\`) and \`NativeHistogramMinResetDuration\` (e.g. \`time.Hour\`). Keeping \`Buckets\` set exposes classic buckets as well during the migration.
- **Java (client_java ≥ 1.0):** \`Histogram\` exposes native and classic buckets by default; use \`.nativeOnly()\` once consumers have moved (\`.nativeMaxNumberOfBuckets(...)\` caps size). The older simpleclient has no native histograms.
- **Python (prometheus_client):** native histogram support is limited or absent depending on the version; check the release notes. The OpenTelemetry SDK is the dependable route.
- **OpenTelemetry SDKs:** use the base-2 exponential histogram aggregation (a view with \`ExponentialBucketHistogramAggregation\`, or \`OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION=base2_exponential_bucket_histogram\`). Prometheus' OTLP receiver and Mimir store these as native histograms.

### 2. Collection

- **Prometheus 2.40 – 3.x before native histograms went stable:** start with \`--enable-feature=native-histograms\`.
- **Newer Prometheus 3.x:** the flag was replaced by the \`scrape_native_histograms: true\` setting (global or per scrape config). Check the docs for your exact version.
- Scraping needs the protobuf format: make sure \`scrape_protocols\` puts \`PrometheusProto\` first (enabling native histograms does this by default in most versions).
- While dashboards still read the old buckets, set \`always_scrape_classic_histograms: true\` so both are stored, then remove it (that is when series drop).
- **Grafana Cloud / Mimir:** native histogram ingestion must be enabled for the tenant (Grafana Cloud supports it). Grafana Alloy needs protobuf scraping on \`prometheus.scrape\` too.
- No client change possible? Prometheus 3.x can store classic histograms as native histograms with custom buckets (\`convert_classic_histograms_to_nhcb\`, check your version). That cuts series without re-instrumenting, but keeps the same bucket resolution.

### 3. Queries

- \`histogram_quantile(0.99, sum by (le) (rate(${family.base}_bucket[5m])))\` becomes \`histogram_quantile(0.99, sum(rate(${family.base}[5m])))\`.
- \`rate(${family.base}_count[5m])\` becomes \`histogram_count(rate(${family.base}[5m]))\`, and \`_sum\` becomes \`histogram_sum(...)\`.
- Thresholds on a fixed bucket (\`le="0.5"\`) become \`histogram_fraction(0, 0.5, ...)\`.
- Update dashboards, alerts and recording rules before the classic series stop.
`
}
