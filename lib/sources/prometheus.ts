import { runWithConcurrency } from "@/lib/core/concurrency"
import { jobLabel } from "@/lib/core/jobs"
import { queries, quoteLabelValue, selector, type SeriesSelector } from "@/lib/core/promql"
import { histogramFamily } from "@/lib/core/families"
import type { DropLabelsRule, Rule, RuleImpact } from "@/lib/core/rules"
import { buildJobDrilldownFromRows, buildSnapshotFromRows, type Snapshot } from "@/lib/core/snapshot"
import { HttpError, sendJson, type Connection } from "@/lib/sources/transport"
import type {
  JobDrilldownResponse,
  JobMetricSeries,
  MetricDrilldown,
  PrometheusResponse,
} from "@/lib/prometheus/types"

// Series without a job label have job "" everywhere (see lib/core/jobs.ts).

interface VectorSample {
  metric: Record<string, string>
  value: [number, string]
}

interface CallOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

async function api<T>(
  connection: Connection,
  path: string,
  query: Record<string, string | string[]> = {},
  signal?: AbortSignal
): Promise<T> {
  const payload = await sendJson<PrometheusResponse<T>>(connection, {
    path: `/api/v1${path}`,
    query,
    signal,
  })
  if (payload.status !== "success" || payload.data === undefined) {
    throw new Error(payload.error ?? "Prometheus API returned an error")
  }
  return payload.data
}

async function instant(connection: Connection, query: string, signal?: AbortSignal) {
  const data = await api<{ result: VectorSample[] }>(connection, "/query", { query }, signal)
  return data.result
}

async function scalarCount(connection: Connection, query: string, signal?: AbortSignal) {
  const [sample] = await instant(connection, query, signal)
  const value = Number(sample?.value?.[1] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function jobMatchers(job: string | undefined) {
  return job === undefined ? undefined : { job }
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

export function fetchLabelNames(connection: Connection, sel?: SeriesSelector, signal?: AbortSignal) {
  return api<string[]>(
    connection,
    "/labels",
    sel ? { "match[]": selector(sel) } : {},
    signal
  )
}

async function fetchJobMetricRows(connection: Connection, signal?: AbortSignal): Promise<JobMetricSeries[]> {
  const rows = await instant(connection, queries.seriesByJobAndMetric(), signal)
  return rows.map((row) => ({
    job: row.metric.job ?? "",
    metric: row.metric.__name__ ?? "unknown",
    seriesCount: Number(row.value[1]) || 0,
  }))
}

/** Where a running snapshot is. `total` is 0 while the number of steps is not known yet. */
export interface SnapshotProgress {
  done: number
  total: number
  phase: string
}

interface SnapshotOptions extends CallOptions {
  onStep?: (progress: SnapshotProgress) => void
}

const LIMIT_PATTERN =
  /limit|too many|exceed|max(imum)?[ _-]?(series|samples|chunks|fetched)|timed? ?out|resource ?exhausted|context deadline/i

/**
 * The backend refused a query for its size: Mimir's max-series / max-fetched
 * limits (422), Prometheus' --query.max-samples (422), or a query timeout.
 */
export function isQueryLimitError(error: unknown) {
  if (!(error instanceof HttpError)) return false
  if (error.proxyFailure) return error.proxyFailure === "timeout"
  if (error.status === 401 || error.status === 403 || error.status === 404) return false
  if ([413, 422, 503, 504].includes(error.status)) return true
  return LIMIT_PATTERN.test(error.detail)
}

interface CardinalityLabelValues {
  series_count_total?: number
  labels?: Array<{
    label_name: string
    label_values_count?: number
    cardinality?: Array<{ label_value: string; series_count: number }>
  }>
}

/** Mimir's cardinality API caps each answer at this many values. */
const CARDINALITY_LIMIT = 500

/**
 * Series per value of one label from Mimir's cardinality API (needs
 * -querier.cardinality-analysis-enabled; on in Grafana Cloud). Returns the
 * top 500 values and whether more exist.
 */
async function fetchCardinalityValues(connection: Connection, label: string, sel: string | undefined, signal?: AbortSignal) {
  const query: Record<string, string> = { "label_names[]": label, limit: String(CARDINALITY_LIMIT), count_method: "active" }
  if (sel) query.selector = sel
  const payload = await sendJson<CardinalityLabelValues>(connection, { path: "/api/v1/cardinality/label_values", query, signal })
  const entry = payload.labels?.find((item) => item.label_name === label)
  const values = entry?.cardinality ?? []
  return { values, truncated: (entry?.label_values_count ?? values.length) > values.length }
}

async function listJobs(connection: Connection, signal?: AbortSignal): Promise<string[]> {
  try {
    return await api<string[]>(connection, "/label/job/values", {}, signal)
  } catch (error) {
    if (isAbort(error) || !isQueryLimitError(error)) throw error
    const { values } = await fetchCardinalityValues(connection, "job", undefined, signal)
    return values.map((value) => value.label_value)
  }
}

/**
 * Snapshot rows one job at a time, for tenants too large for one
 * `count by (job, __name__)`. A job whose own query is still too large is
 * counted with Mimir's cardinality API; a job nothing can count is skipped.
 */
async function fetchRowsPerJob(connection: Connection, options: SnapshotOptions) {
  const step = options.onStep ?? (() => undefined)
  step({ done: 0, total: 0, phase: "Listing jobs" })
  // "" = series without a job label.
  const jobs = ["", ...(await listJobs(connection, options.signal)).filter((job) => job !== "")]
  const skippedJobs: string[] = []
  const truncatedJobs: string[] = []
  let done = 0
  step({ done, total: jobs.length, phase: "Querying jobs" })

  const perJob = await runWithConcurrency(
    jobs,
    async (job): Promise<JobMetricSeries[]> => {
      try {
        const rows = await instant(connection, queries.seriesByMetricForJob(job), options.signal)
        return rows.map((row) => ({ job, metric: row.metric.__name__ ?? "unknown", seriesCount: Number(row.value[1]) || 0 }))
      } catch (error) {
        if (isAbort(error) || (error instanceof HttpError && (error.status === 401 || error.status === 403))) throw error
        if (!isQueryLimitError(error)) {
          skippedJobs.push(job)
          return []
        }
        try {
          const sel = `{__name__=~".+",job=${quoteLabelValue(job)}}`
          const { values, truncated } = await fetchCardinalityValues(connection, "__name__", sel, options.signal)
          if (truncated) truncatedJobs.push(job)
          return values.map((value) => ({ job, metric: value.label_value, seriesCount: value.series_count }))
        } catch (fallbackError) {
          if (isAbort(fallbackError)) throw fallbackError
          skippedJobs.push(job)
          return []
        }
      } finally {
        done += 1
        step({ done, total: jobs.length, phase: "Querying jobs" })
      }
    },
    4,
    options.signal
  )
  options.onProgress?.(
    `Counted ${jobs.length - skippedJobs.length} of ${jobs.length} jobs one by one` +
      (skippedJobs.length ? `; skipped ${skippedJobs.length}` : "") +
      (truncatedJobs.length ? `; ${truncatedJobs.length} capped at ${CARDINALITY_LIMIT} metrics` : "")
  )
  return { rows: perJob.flat(), skippedJobs, truncatedJobs }
}

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

export async function fetchSnapshot(
  connection: Connection,
  topN: number,
  options: SnapshotOptions = {}
): Promise<Snapshot> {
  options.onProgress?.("Counting active series by job and metric")
  options.onStep?.({ done: 0, total: 0, phase: "Counting active series" })
  // The label-name list only feeds a stat, so its failure must not fail the snapshot.
  const labels = fetchLabelNames(connection, undefined, options.signal).catch((error: unknown) => {
    if (isAbort(error)) throw error
    return null
  })
  labels.catch(() => undefined)

  let rows: JobMetricSeries[]
  let fallback: Awaited<ReturnType<typeof fetchRowsPerJob>> | null = null
  try {
    rows = await fetchJobMetricRows(connection, options.signal)
  } catch (error) {
    if (!isQueryLimitError(error)) throw error
    options.onProgress?.(`The full count hit a query limit, counting per job instead (${(error as Error).message})`)
    fallback = await fetchRowsPerJob(connection, options)
    rows = fallback.rows
  }
  const labelNames = await labels
  options.onProgress?.(`Aggregated ${rows.length.toLocaleString()} job/metric pairs`)
  const snapshot = buildSnapshotFromRows(rows, labelNames?.length ?? null, topN)
  return {
    ...snapshot,
    host: hostOf(connection.baseUrl),
    method: fallback ? "per-job" : "query",
    ...(fallback?.skippedJobs.length ? { skippedJobs: fallback.skippedJobs } : {}),
    ...(fallback?.truncatedJobs.length ? { truncatedJobs: fallback.truncatedJobs } : {}),
  }
}

export interface ConnectionCheck {
  /** Prometheus / Mimir version from buildinfo, when the backend reports it. */
  version: string | null
  latencyMs: number
}

/**
 * Cheap check before a snapshot: `vector(1)` proves the URL, auth and query
 * API work without touching any series; buildinfo only adds the version.
 */
export async function testConnection(connection: Connection, signal?: AbortSignal): Promise<ConnectionCheck> {
  const started = performance.now()
  await instant(connection, "vector(1)", signal)
  const latencyMs = Math.round(performance.now() - started)
  const build = await api<{ version?: string }>(connection, "/status/buildinfo", {}, signal).catch((error: unknown) => {
    if (isAbort(error)) throw error
    return null
  })
  return { version: build?.version ?? null, latencyMs }
}

export async function fetchJobDrilldown(
  connection: Connection,
  job: string,
  options: CallOptions = {}
): Promise<JobDrilldownResponse> {
  options.onProgress?.(`Loading metrics for job ${jobLabel(job)}`)
  const rows = await instant(connection, queries.seriesByMetricForJob(job), options.signal)
  return buildJobDrilldownFromRows(
    rows.map((row) => ({ job, metric: row.metric.__name__ ?? "unknown", seriesCount: Number(row.value[1]) || 0 })),
    job
  )
}

/**
 * Per-label distinct value counts computed server-side, so high-cardinality
 * metrics never ship their raw series to the browser.
 */
export async function fetchMetricDrilldown(
  connection: Connection,
  metric: string,
  options: CallOptions & { job?: string } = {}
): Promise<MetricDrilldown> {
  const sel: SeriesSelector = { metric, matchers: jobMatchers(options.job) }
  options.onProgress?.(`Loading label split for ${metric}`)
  const [labelNames, seriesCount] = await Promise.all([
    fetchLabelNames(connection, sel, options.signal),
    scalarCount(connection, queries.seriesCount(sel), options.signal),
  ])
  const labels = await runWithConcurrency(
    labelNames.filter((label) => label !== "__name__"),
    async (label) => ({
      label,
      cardinality: await scalarCount(connection, queries.labelCardinality(sel, label), options.signal),
    }),
    4,
    options.signal
  )
  return {
    metric,
    seriesCount,
    labels: labels.filter((label) => label.cardinality > 0).sort((a, b) => b.cardinality - a.cardinality),
  }
}

export interface LabelValueCount {
  value: string
  seriesCount: number
}

export async function fetchTopLabelValues(
  connection: Connection,
  metric: string,
  label: string,
  options: { job?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<LabelValueCount[]> {
  const sel: SeriesSelector = { metric, matchers: jobMatchers(options.job) }
  const rows = await instant(connection, queries.topLabelValues(sel, label, options.limit ?? 50), options.signal)
  return rows
    .map((row) => ({ value: row.metric[label] ?? "", seriesCount: Number(row.value[1]) || 0 }))
    .sort((a, b) => b.seriesCount - a.seriesCount)
}

export async function fetchSeriesByJob(connection: Connection, metric: string, signal?: AbortSignal) {
  const rows = await instant(connection, queries.seriesByJob({ metric }), signal)
  return rows
    .map((row) => ({ job: row.metric.job ?? "", seriesCount: Number(row.value[1]) || 0 }))
    .sort((a, b) => b.seriesCount - a.seriesCount)
}

/**
 * Exact impact: counts series before and after the rule with PromQL. A label
 * drop keeping one value per label counts the series it keeps; `mergesSeries`
 * always says whether dropping the labels outright would merge series.
 */
export async function measureImpact(
  connection: Connection,
  rule: Pick<Rule, "kind" | "selector"> & Partial<Pick<DropLabelsRule, "labels" | "onMerge" | "keepValues">>,
  signal?: AbortSignal
): Promise<RuleImpact> {
  const sel: SeriesSelector = { metric: rule.selector.metric, matchers: jobMatchers(rule.selector.job) }
  const labelDrop = rule.kind === "drop_labels" && Boolean(rule.labels?.length)
  const keep = rule.onMerge === "keep_value" && rule.keepValues && Object.keys(rule.keepValues).length ? rule.keepValues : null
  const [seriesBefore, merged, kept] = await Promise.all([
    scalarCount(connection, queries.seriesCount(sel), signal),
    labelDrop ? scalarCount(connection, queries.seriesWithoutLabels(sel, rule.labels!), signal) : Promise.resolve(0),
    labelDrop && keep ? scalarCount(connection, queries.seriesKeeping(sel, keep), signal) : Promise.resolve(null),
  ])
  return {
    seriesBefore,
    seriesAfter: kept ?? merged,
    exact: true,
    mergesSeries: labelDrop && merged < seriesBefore,
    measuredAt: new Date().toISOString(),
  }
}

/** A group of series that would become one: the labels they share, and how many there are. */
export interface MergeGroup {
  labels: Record<string, string>
  series: number
}

/** A few concrete groups that dropping `labels` would merge, largest first (one bounded topk query). */
export async function fetchMergeGroups(
  connection: Connection,
  target: { metric: string; job?: string; labels: string[] },
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<MergeGroup[]> {
  const sel: SeriesSelector = { metric: target.metric, matchers: jobMatchers(target.job) }
  const rows = await instant(connection, queries.mergeGroups(sel, target.labels, options.limit ?? 3), options.signal)
  return rows.map((row) => ({ labels: row.metric, series: Number(row.value[1]) || 0 })).sort((a, b) => b.series - a.series)
}

export type MetricType = "counter" | "gauge" | "histogram" | "gaugehistogram" | "summary" | "info" | "stateset" | "unknown"

/** The metric's type from /api/v1/metadata (histogram and summary parts use their family's name); "unknown" when not reported. */
export async function fetchMetricType(connection: Connection, metric: string, signal?: AbortSignal): Promise<MetricType> {
  const names = Array.from(new Set([metric, histogramFamily(metric).base]))
  for (const name of names) {
    const data = await api<Record<string, Array<{ type?: string }>>>(connection, "/metadata", { metric: name, limit: "1" }, signal)
    const type = data[name]?.[0]?.type
    if (type) return type as MetricType
  }
  return "unknown"
}

interface RulesResponse {
  groups: Array<{
    name: string
    file?: string
    rules: Array<{ name: string; query: string; type: "alerting" | "recording" }>
  }>
}

export interface RuleUsage {
  group: string
  name: string
  type: "alerting" | "recording"
}

/**
 * Finds alerting/recording rules referencing each metric. Grafana-managed
 * alerts and dashboards are not visible through this API.
 */
export async function fetchRuleUsage(
  connection: Connection,
  metrics: string[],
  signal?: AbortSignal
): Promise<Record<string, RuleUsage[]>> {
  const data = await api<RulesResponse>(connection, "/rules", {}, signal)
  const usage: Record<string, RuleUsage[]> = Object.fromEntries(metrics.map((metric) => [metric, []]))
  const patterns = metrics.map((metric) => ({
    metric,
    pattern: new RegExp(`(^|[^a-zA-Z0-9_:])${metric.replace(/[:]/g, "\\:")}($|[^a-zA-Z0-9_:])`),
  }))
  for (const group of data.groups) {
    for (const rule of group.rules) {
      for (const { metric, pattern } of patterns) {
        if (pattern.test(rule.query)) usage[metric].push({ group: group.name, name: rule.name, type: rule.type })
      }
    }
  }
  return usage
}

export type HistoryRange = "24h" | "7d" | "30d"

const RANGES: Record<HistoryRange, { seconds: number; step: number }> = {
  "24h": { seconds: 24 * 3600, step: 30 * 60 },
  "7d": { seconds: 7 * 24 * 3600, step: 3 * 3600 },
  "30d": { seconds: 30 * 24 * 3600, step: 12 * 3600 },
}

export interface HistoryPoint {
  t: number
  value: number
}

interface MatrixSample {
  metric: Record<string, string>
  values: Array<[number, string]>
}

/**
 * Active series over time. Prefers the TSDB head size (cheap), but only when
 * it agrees with the snapshot total: on Mimir/Grafana Cloud that metric
 * describes scraped Prometheus servers, not this backend. Otherwise counts
 * every series per step, which is exact but slow on large instances.
 */
export async function fetchSeriesHistory(
  connection: Connection,
  range: HistoryRange,
  expectedTotal: number | undefined,
  signal?: AbortSignal
): Promise<{ points: HistoryPoint[]; source: "count" | "tsdb-head" }> {
  const { seconds, step } = RANGES[range]
  const end = Math.floor(Date.now() / 1000 / step) * step
  const params = { start: String(end - seconds), end: String(end), step: String(step) }

  const run = async (query: string) => {
    const data = await api<{ result: MatrixSample[] }>(connection, "/query_range", { query, ...params }, signal)
    const values = data.result[0]?.values ?? []
    return values.map(([t, value]) => ({ t: t * 1000, value: Number(value) || 0 }))
  }

  const head = await run("sum(prometheus_tsdb_head_series)").catch((error: unknown) => {
    if (isAbort(error)) throw error
    return []
  })
  const latest = head[head.length - 1]?.value
  if (latest && expectedTotal && Math.abs(latest - expectedTotal) / expectedTotal < 0.25) {
    return { points: head, source: "tsdb-head" }
  }
  return { points: await run('count({__name__=~".+"})'), source: "count" }
}

export interface TsdbStatus {
  labelValueCountByLabelName: Array<{ name: string; value: number }>
  seriesCountByLabelValuePair: Array<{ name: string; value: number }>
}

/** Prometheus' own head statistics. Not available on Mimir / Grafana Cloud. */
export async function fetchTsdbStatus(connection: Connection, signal?: AbortSignal): Promise<TsdbStatus> {
  return api<TsdbStatus>(connection, "/status/tsdb", { limit: "10" }, signal)
}
