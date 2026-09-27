import {
  CHURN_WINDOW_SECONDS,
  HIGH_CHURN_RATIO,
  churnCost,
  churnDriver,
  isChurnWindow,
  mergeChurn,
  rankChurn,
  rankLabelDrivers,
  summarizeChurn,
  type ChurnRow,
  type ChurnSummary,
  type ChurnWindow,
  type LabelChurn,
} from "@/lib/core/churn"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { assertLabelName, queries, quoteLabelValue, selector, type SeriesSelector } from "@/lib/core/promql"
import { isQueryLimitError } from "@/lib/sources/prometheus"
import { HttpError, sendJson, type Connection } from "@/lib/sources/transport"
import type { JobMetricSeries, PrometheusResponse } from "@/lib/prometheus/types"

// Churn queries: series seen over a window (last_over_time) against series
// active now, both evaluated at the same instant.

function range(window: ChurnWindow) {
  if (!isChurnWindow(window)) throw new Error(`Invalid churn window: ${JSON.stringify(window)}`)
  return window
}

function jobSelector(job: string) {
  return `{__name__=~".+",job=${quoteLabelValue(job)}}`
}

export const churnQueries = {
  /** Series with a sample in the window, per job and metric. */
  seenByJobAndMetric: (window: ChurnWindow) => `count by (job, __name__) (last_over_time({__name__=~".+"}[${range(window)}]))`,
  seenByMetricForJob: (job: string, window: ChurnWindow) => `count by (__name__) (last_over_time(${jobSelector(job)}[${range(window)}]))`,
  /** Prometheus' own series-creation counter; absent on Mimir and Grafana Cloud. */
  seriesCreatedRate: (window: ChurnWindow) => `sum(rate(prometheus_tsdb_head_series_created_total[${range(window)}]))`,
  seriesSeen: (sel: SeriesSelector, window: ChurnWindow) => `count(last_over_time(${selector(sel)}[${range(window)}]))`,
  /** Distinct values `label` took over the window. */
  labelValuesSeen: (sel: SeriesSelector, label: string, window: ChurnWindow) =>
    `count(count by (${assertLabelName(label)}) (last_over_time(${selector(sel)}[${range(window)}])))`,
}

interface VectorSample {
  metric: Record<string, string>
  value: [number, string]
}

async function api<T>(connection: Connection, path: string, query: Record<string, string | string[]>, signal?: AbortSignal) {
  const payload = await sendJson<PrometheusResponse<T>>(connection, { path: `/api/v1${path}`, query, signal })
  if (payload.status !== "success" || payload.data === undefined) throw new Error(payload.error ?? "Prometheus API returned an error")
  return payload.data
}

async function instant(connection: Connection, query: string, time: number, signal?: AbortSignal) {
  return (await api<{ result: VectorSample[] }>(connection, "/query", { query, time: String(time) }, signal)).result
}

async function scalar(connection: Connection, query: string, time: number, signal?: AbortSignal) {
  const [sample] = await instant(connection, query, time, signal)
  const value = Number(sample?.value?.[1] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function isAuth(error: unknown) {
  return error instanceof HttpError && (error.status === 401 || error.status === 403)
}

const toRows = (samples: VectorSample[], job?: string): JobMetricSeries[] =>
  samples.map((sample) => ({
    job: job ?? sample.metric.job ?? "",
    metric: sample.metric.__name__ ?? "unknown",
    seriesCount: Number(sample.value[1]) || 0,
  }))

/** Where a running churn measurement is. `total` is 0 while unknown. */
export interface ChurnProgress {
  done: number
  total: number
  phase: string
}

export interface ChurnOptions {
  signal?: AbortSignal
  /** Only this job ("" = series without a job label). */
  job?: string
  /** Jobs for the per-job fallback, e.g. from the snapshot; listed from the backend when absent. */
  jobs?: string[]
  onStep?: (progress: ChurnProgress) => void
  onProgress?: (message: string) => void
}

export interface ChurnResult {
  window: ChurnWindow
  /** Unix seconds every query was evaluated at. */
  at: number
  rows: ChurnRow[]
  summary: ChurnSummary
  /** "query": one query for everything; "per-job": fallback after a query limit; "job": one job was asked for. */
  method: "query" | "per-job" | "job"
  /** Jobs left out because their own queries failed. */
  skippedJobs: string[]
  /** Series created per second over the window (Prometheus only), or null when the backend doesn't expose it. */
  creationRate: number | null
}

async function pairRowsForJob(connection: Connection, job: string, window: ChurnWindow, at: number, signal?: AbortSignal) {
  const [seen, active] = await Promise.all([
    instant(connection, churnQueries.seenByMetricForJob(job, window), at, signal),
    instant(connection, queries.seriesByMetricForJob(job), at, signal),
  ])
  return { seen: toRows(seen, job), active: toRows(active, job) }
}

async function listJobs(connection: Connection, signal?: AbortSignal) {
  return api<string[]>(connection, "/label/job/values", {}, signal)
}

async function fetchPerJob(connection: Connection, window: ChurnWindow, at: number, options: ChurnOptions) {
  const step = options.onStep ?? (() => undefined)
  step({ done: 0, total: 0, phase: "Listing jobs" })
  const known = options.jobs ?? (await listJobs(connection, options.signal))
  const jobs = ["", ...known.filter((job) => job !== "")]
  const skippedJobs: string[] = []
  let done = 0
  step({ done, total: jobs.length, phase: "Measuring churn per job" })
  const results = await runWithConcurrency(
    jobs,
    async (job) => {
      try {
        return await pairRowsForJob(connection, job, window, at, options.signal)
      } catch (error) {
        if (isAbort(error) || isAuth(error)) throw error
        skippedJobs.push(job)
        return { seen: [], active: [] }
      } finally {
        done += 1
        step({ done, total: jobs.length, phase: "Measuring churn per job" })
      }
    },
    4,
    options.signal
  )
  options.onProgress?.(`Measured churn for ${jobs.length - skippedJobs.length} of ${jobs.length} jobs one by one`)
  return {
    seen: results.flatMap((result) => result.seen),
    active: results.flatMap((result) => result.active),
    skippedJobs,
  }
}

/** Series created per second over the window, or null when the counter isn't there. */
export async function fetchSeriesCreationRate(connection: Connection, window: ChurnWindow, at = Date.now() / 1000, signal?: AbortSignal) {
  try {
    const [sample] = await instant(connection, churnQueries.seriesCreatedRate(window), at, signal)
    const value = Number(sample?.value?.[1])
    return sample && Number.isFinite(value) ? value : null
  } catch (error) {
    if (isAbort(error)) throw error
    return null
  }
}

/**
 * Series seen over the window against series active now, per job and metric.
 * Falls back to one job at a time when the backend refuses the full query.
 */
export async function fetchChurn(connection: Connection, window: ChurnWindow, options: ChurnOptions = {}): Promise<ChurnResult> {
  range(window)
  const at = Math.floor(Date.now() / 1000)
  const step = options.onStep ?? (() => undefined)
  const creation =
    options.job === undefined ? fetchSeriesCreationRate(connection, window, at, options.signal) : Promise.resolve(null)
  creation.catch(() => undefined)

  let seen: JobMetricSeries[]
  let active: JobMetricSeries[]
  let method: ChurnResult["method"] = "query"
  let skippedJobs: string[] = []

  if (options.job !== undefined) {
    method = "job"
    step({ done: 0, total: 0, phase: "Counting series seen" })
    ;({ seen, active } = await pairRowsForJob(connection, options.job, window, at, options.signal))
  } else {
    step({ done: 0, total: 0, phase: "Counting series seen" })
    options.onProgress?.(`Counting series seen over the last ${window}`)
    try {
      const [seenSamples, activeSamples] = await Promise.all([
        instant(connection, churnQueries.seenByJobAndMetric(window), at, options.signal),
        instant(connection, queries.seriesByJobAndMetric(), at, options.signal),
      ])
      seen = toRows(seenSamples)
      active = toRows(activeSamples)
    } catch (error) {
      if (!isQueryLimitError(error)) throw error
      options.onProgress?.(`The churn query hit a query limit, measuring per job instead (${(error as Error).message})`)
      method = "per-job"
      ;({ seen, active, skippedJobs } = await fetchPerJob(connection, window, at, options))
    }
  }

  const rows = mergeChurn(seen, active)
  return { window, at, rows, summary: summarizeChurn(rows), method, skippedJobs, creationRate: await creation }
}

export interface LabelDrivers {
  metric: string
  job?: string
  window: ChurnWindow
  seriesSeen: number
  seriesNow: number
  /** Labels by values that came and went, biggest jump first. */
  labels: LabelChurn[]
  /** The label with the biggest jump, when any label changed. */
  driver?: LabelChurn
  /** Labels whose queries failed (e.g. a query limit). */
  skippedLabels: string[]
}

/**
 * For each label of a metric, distinct values seen over the window against
 * distinct values now. The label with the biggest jump drives the churn.
 */
export async function fetchLabelDrivers(
  connection: Connection,
  metric: string,
  window: ChurnWindow,
  options: { job?: string; signal?: AbortSignal; onStep?: (progress: ChurnProgress) => void } = {}
): Promise<LabelDrivers> {
  range(window)
  const at = Math.floor(Date.now() / 1000)
  const sel: SeriesSelector = { metric, matchers: options.job === undefined ? undefined : { job: options.job } }
  const step = options.onStep ?? (() => undefined)
  step({ done: 0, total: 0, phase: "Listing labels" })
  const [names, seriesSeen, seriesNow] = await Promise.all([
    api<string[]>(
      connection,
      "/labels",
      { "match[]": selector(sel), start: String(at - CHURN_WINDOW_SECONDS[window]), end: String(at) },
      options.signal
    ),
    scalar(connection, churnQueries.seriesSeen(sel, window), at, options.signal),
    scalar(connection, queries.seriesCount(sel), at, options.signal),
  ])
  const labels = names.filter((label) => label !== "__name__" && (options.job === undefined || label !== "job"))
  const skippedLabels: string[] = []
  let done = 0
  step({ done, total: labels.length, phase: "Comparing label values" })
  const counted = await runWithConcurrency(
    labels,
    async (label) => {
      try {
        const [seen, now] = await Promise.all([
          scalar(connection, churnQueries.labelValuesSeen(sel, label, window), at, options.signal),
          scalar(connection, queries.labelCardinality(sel, label), at, options.signal),
        ])
        return { label, seen, now }
      } catch (error) {
        if (isAbort(error) || isAuth(error)) throw error
        skippedLabels.push(label)
        return null
      } finally {
        done += 1
        step({ done, total: labels.length, phase: "Comparing label values" })
      }
    },
    4,
    options.signal
  )
  const ranked = rankLabelDrivers(counted.filter((item) => item !== null))
  return {
    metric,
    ...(options.job === undefined ? {} : { job: options.job }),
    window,
    seriesSeen: Math.max(seriesSeen, seriesNow),
    seriesNow,
    labels: ranked,
    driver: churnDriver(ranked),
    skippedLabels,
  }
}

export interface ChurnReportOptions {
  window: ChurnWindow
  job?: string
  metric?: string
  limit: number
  jobs?: string[]
  pricePer1kSeries?: number
  signal?: AbortSignal
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits))

/** Compact churn answer for agents: top churning pairs and, for a metric, its label drivers. */
export async function churnReport(connection: Connection, options: ChurnReportOptions) {
  const { window, job, metric, limit, signal } = options
  const [churn, drivers] = await Promise.all([
    fetchChurn(connection, window, { job, jobs: options.jobs, signal }),
    metric ? fetchLabelDrivers(connection, metric, window, { job, signal }) : Promise.resolve(null),
  ])
  const { summary } = churn
  const cost = churnCost(summary.churned, options.pricePer1kSeries)
  return {
    window,
    job: job ?? null,
    method: churn.method,
    ...(churn.skippedJobs.length ? { skipped_jobs: churn.skippedJobs } : {}),
    summary: {
      series_seen: summary.seen,
      series_active: summary.active,
      series_churned: summary.churned,
      churn_percent_of_active: round(summary.churnPercent),
      churning_pairs: summary.churningPairs,
      high_churn_pairs: summary.highPairs,
    },
    series_created_per_hour: churn.creationRate === null ? null : Math.round(churn.creationRate * 3600),
    ...(churn.creationRate === null && job === undefined
      ? { series_created_note: "prometheus_tsdb_head_series_created_total is not exposed (normal on Mimir and Grafana Cloud)." }
      : {}),
    top: rankChurn(churn.rows, limit).map((row) => ({
      job: row.job,
      metric: row.metric,
      seen: row.seen,
      active: row.active,
      churned: row.churned,
      ratio: row.ratio === null ? null : round(row.ratio),
      high: row.high,
    })),
    cost: { monthly_estimate: cost.monthly === null ? null : round(cost.monthly), note: cost.note },
    ...(drivers
      ? {
          label_drivers: {
            metric: drivers.metric,
            series_seen: drivers.seriesSeen,
            series_now: drivers.seriesNow,
            driver: drivers.driver?.label ?? null,
            labels: drivers.labels.slice(0, 10).map((item) => ({ label: item.label, values_seen: item.seen, values_now: item.now, jump: item.jump })),
            ...(drivers.skippedLabels.length ? { skipped_labels: drivers.skippedLabels } : {}),
          },
        }
      : {}),
    note: `seen = series with a sample in the last ${window}; ratio = seen / active (null: none active now); high = ratio above ${HIGH_CHURN_RATIO}. Dropping a driver label merges series, so propose it as a drop_labels rule and expect merges_series=true.`,
  }
}
