import { runWithConcurrency } from "@/lib/core/concurrency"
import { anyValueSelector, streamSelector } from "@/lib/core/logql"
import {
  buildLogsSnapshot,
  isInternalLabel,
  LOGS_RANGE_SECONDS,
  MAX_GROUPS,
  MAX_LABEL_VALUES,
  pickGroupLabel,
  sumVolumeSeries,
  volumeStepSeconds,
} from "@/lib/core/logs/snapshot"
import type { LabelMatcher, LogsRange, LogsSnapshot, LogsSnapshotProgress, StreamSelector } from "@/lib/core/logs/types"
import { HttpError, sendJson, type Connection } from "@/lib/sources/transport"

// Loki HTTP API client. Every call is a GET under /loki/api/v1, takes an
// AbortSignal, and builds selectors through lib/core/logql.ts. Times go out as
// Unix nanoseconds.

/** A selector as matchers, or one already built by `streamSelector`. */
export type SelectorInput = StreamSelector | LabelMatcher[] | { text: string }

export interface TimeRange {
  /** Unix milliseconds. */
  start: number
  end: number
}

interface CallOptions {
  signal?: AbortSignal
  range?: TimeRange
}

interface LokiEnvelope<T> {
  status?: string
  data?: T
  error?: string
  message?: string
}

/** Requests in flight per Loki connection, across every page and tool: public Lokis (Grafana Play) are shared. */
export const LOKI_CONCURRENCY = 4
const CONCURRENCY = LOKI_CONCURRENCY

interface Limiter {
  running: number
  queue: Array<() => void>
}

const limiters = new Map<string, Limiter>()

function limiterFor(connection: Connection) {
  const key = `${connection.mode}:${connection.baseUrl.trim().replace(/\/+$/, "")}`
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = { running: 0, queue: [] }
    limiters.set(key, limiter)
  }
  return limiter
}

/**
 * Runs `task` when fewer than LOKI_CONCURRENCY requests to this connection are
 * in flight; queued tasks start in order. Every Loki call in Cardinal goes
 * through here (the API calls below do it themselves). A task whose signal
 * aborts while queued never starts.
 */
export function withLokiLimit<T>(connection: Connection, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const limiter = limiterFor(connection)
  return new Promise<T>((resolve, reject) => {
    const next = () => {
      if (limiter.running >= LOKI_CONCURRENCY) return
      const start = limiter.queue.shift()
      if (start) start()
    }
    const onAbort = () => {
      const index = limiter.queue.indexOf(start)
      if (index !== -1) limiter.queue.splice(index, 1)
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const start = () => {
      signal?.removeEventListener("abort", onAbort)
      limiter.running += 1
      let result: Promise<T>
      try {
        result = task()
      } catch (error) {
        result = Promise.reject(error)
      }
      result.then(resolve, reject).finally(() => {
        limiter.running -= 1
        next()
      })
    }
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    limiter.queue.push(start)
    next()
  })
}

export function selectorText(selector: SelectorInput) {
  return "text" in selector ? selector.text : streamSelector(selector)
}

/** The last `range` up to now (or `now`), in Unix ms. */
export function timeRangeFor(range: LogsRange, now = Date.now()): TimeRange {
  return { start: now - LOGS_RANGE_SECONDS[range] * 1000, end: now }
}

function ns(ms: number) {
  return `${Math.floor(ms)}000000`
}

function timeQuery(range: TimeRange | undefined): Record<string, string> {
  return range ? { start: ns(range.start), end: ns(range.end) } : {}
}

function isAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

/** 404 / 501: the endpoint isn't there (older Loki, or the feature is off). */
export function isMissingEndpoint(error: unknown) {
  return error instanceof HttpError && !error.proxyFailure && (error.status === 404 || error.status === 501)
}

async function raw<T>(connection: Connection, path: string, query: Record<string, string | string[]>, signal?: AbortSignal) {
  return withLokiLimit(connection, () => sendJson<T>(connection, { path: `/loki/api/v1${path}`, query, signal }), signal)
}

async function api<T>(connection: Connection, path: string, query: Record<string, string | string[]>, signal?: AbortSignal): Promise<T> {
  const payload = await raw<LokiEnvelope<T>>(connection, path, query, signal)
  if (payload.status !== "success" || payload.data === undefined) {
    throw new Error(payload.error ?? payload.message ?? "Loki API returned an error")
  }
  return payload.data
}

export async function fetchLokiLabels(connection: Connection, options: CallOptions & { selector?: SelectorInput } = {}): Promise<string[]> {
  const query = { ...timeQuery(options.range), ...(options.selector ? { query: selectorText(options.selector) } : {}) }
  return (await api<string[] | null>(connection, "/labels", query, options.signal)) ?? []
}

export async function fetchLokiLabelValues(
  connection: Connection,
  label: string,
  options: CallOptions & { selector?: SelectorInput } = {}
): Promise<string[]> {
  // Validates the name before it goes into the path.
  streamSelector([{ label, op: "=~", value: ".+" }])
  const query = { ...timeQuery(options.range), ...(options.selector ? { query: selectorText(options.selector) } : {}) }
  return (await api<string[] | null>(connection, `/label/${encodeURIComponent(label)}/values`, query, options.signal)) ?? []
}

export interface StreamList {
  series: Array<Record<string, string>>
  /** More streams matched than `limit`. */
  truncated: boolean
}

/** Stream label sets for a selector, capped at `limit` (the API has no limit, so scope the selector). */
export async function fetchLokiSeries(connection: Connection, selector: SelectorInput, options: CallOptions & { limit?: number } = {}): Promise<StreamList> {
  const limit = Math.max(1, Math.min(5000, options.limit ?? 500))
  const series = (await api<Array<Record<string, string>> | null>(connection, "/series", { "match[]": selectorText(selector), ...timeQuery(options.range) }, options.signal)) ?? []
  return { series: series.slice(0, limit), truncated: series.length > limit }
}

export interface IndexStats {
  streams: number
  chunks: number
  entries: number
  bytes: number
}

/** Streams, chunks, lines and bytes for a selector, from the index (cheap). */
export async function fetchIndexStats(connection: Connection, selector: SelectorInput, options: CallOptions = {}): Promise<IndexStats> {
  // index/stats answers bare JSON, without the {status, data} envelope.
  const body = await raw<Partial<IndexStats> & LokiEnvelope<unknown>>(connection, "/index/stats", { query: selectorText(selector), ...timeQuery(options.range) }, options.signal)
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  return { streams: number(body.streams), chunks: number(body.chunks), entries: number(body.entries), bytes: number(body.bytes) }
}

export interface VolumeOptions extends CallOptions {
  /** Labels to group by; by default Loki groups by the selector's labels. */
  targetLabels?: string[]
  aggregateBy?: "series" | "labels"
  limit?: number
}

function volumeQuery(selector: SelectorInput, options: VolumeOptions) {
  const query: Record<string, string> = { query: selectorText(selector), limit: String(Math.max(1, Math.min(5000, options.limit ?? 100))), ...timeQuery(options.range) }
  if (options.targetLabels?.length) {
    // Validates each name.
    for (const label of options.targetLabels) anyValueSelector(label)
    query.targetLabels = options.targetLabels.join(",")
  }
  if (options.aggregateBy) query.aggregateBy = options.aggregateBy
  return query
}

export interface VolumeRow {
  labels: Record<string, string>
  bytes: number
}

/** Bytes per label value (or per stream) from the index. Needs Loki ≥ 2.9 with volume enabled. */
export async function fetchIndexVolume(connection: Connection, selector: SelectorInput, options: VolumeOptions = {}): Promise<VolumeRow[]> {
  const data = await api<{ result?: Array<{ metric: Record<string, string>; value: [number, string] }> }>(connection, "/index/volume", volumeQuery(selector, options), options.signal)
  return (data.result ?? []).map((row) => ({ labels: row.metric ?? {}, bytes: Number(row.value?.[1]) || 0 })).sort((a, b) => b.bytes - a.bytes)
}

export interface VolumeSeries {
  labels: Record<string, string>
  points: Array<{ t: number; value: number }>
}

/** Bytes per step over time, per label value or stream. */
export async function fetchIndexVolumeRange(
  connection: Connection,
  selector: SelectorInput,
  options: VolumeOptions & { stepSeconds: number }
): Promise<VolumeSeries[]> {
  const query = { ...volumeQuery(selector, options), step: String(Math.max(1, Math.floor(options.stepSeconds))) }
  const data = await api<{ result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> }>(connection, "/index/volume_range", query, options.signal)
  return (data.result ?? []).map((row) => ({
    labels: row.metric ?? {},
    points: (row.values ?? []).map(([t, value]) => ({ t: Math.round(t * 1000), value: Number(value) || 0 })),
  }))
}

export interface LogLine {
  /** Unix ms. */
  t: number
  line: string
  labels: Record<string, string>
}

export type QueryRangeResult =
  | { resultType: "matrix"; series: Array<{ labels: Record<string, string>; points: Array<{ t: number; value: number }> }> }
  | { resultType: "streams"; lines: LogLine[] }

/**
 * query_range for a query Cardinal built (see logQueries in lib/core/logql.ts,
 * or a selector for sample lines). Log queries return at most `limit` lines.
 */
export async function fetchLogQueryRange(
  connection: Connection,
  query: string,
  options: CallOptions & { stepSeconds?: number; limit?: number; direction?: "backward" | "forward" } = {}
): Promise<QueryRangeResult> {
  const params: Record<string, string> = { query, ...timeQuery(options.range) }
  if (options.stepSeconds) params.step = String(Math.max(1, Math.floor(options.stepSeconds)))
  if (options.limit) params.limit = String(Math.max(1, Math.min(1000, Math.floor(options.limit))))
  if (options.direction) params.direction = options.direction
  const data = await api<{ resultType: string; result: unknown[] }>(connection, "/query_range", params, options.signal)
  if (data.resultType === "streams") {
    const streams = data.result as Array<{ stream: Record<string, string>; values: Array<[string, string]> }>
    const lines = streams
      .flatMap((stream) => stream.values.map(([t, line]) => ({ t: Number(BigInt(t) / 1_000_000n), line, labels: stream.stream })))
      .sort((a, b) => b.t - a.t)
    return { resultType: "streams", lines: options.limit ? lines.slice(0, options.limit) : lines }
  }
  const matrix = data.result as Array<{ metric: Record<string, string>; values: Array<[number, string]> }>
  return {
    resultType: "matrix",
    series: matrix.map((row) => ({ labels: row.metric ?? {}, points: row.values.map(([t, value]) => ({ t: Math.round(t * 1000), value: Number(value) || 0 })) })),
  }
}

/** Sample lines for a selector, newest first. */
export async function fetchSampleLines(connection: Connection, selector: SelectorInput, options: CallOptions & { limit?: number } = {}) {
  const result = await fetchLogQueryRange(connection, selectorText(selector), { ...options, limit: options.limit ?? 20, direction: "backward" })
  return result.resultType === "streams" ? result.lines : []
}

export interface LogPattern {
  pattern: string
  level?: string
  /** Lines matching the pattern in the range. */
  count: number
  samples: Array<{ t: number; count: number }>
}

/**
 * Line patterns from Loki's pattern ingester (Loki 3.x). Null when this Loki
 * doesn't run it, so callers can say so instead of failing.
 */
export async function fetchPatterns(connection: Connection, selector: SelectorInput, options: CallOptions & { stepSeconds?: number } = {}): Promise<LogPattern[] | null> {
  const params: Record<string, string> = { query: selectorText(selector), ...timeQuery(options.range) }
  if (options.stepSeconds) params.step = String(Math.max(1, Math.floor(options.stepSeconds)))
  try {
    const data = await api<Array<{ pattern: string; level?: string; samples?: Array<[number, number | string]> }> | null>(connection, "/patterns", params, options.signal)
    return (data ?? [])
      .map((item) => {
        const samples = (item.samples ?? []).map(([t, count]) => ({ t: Math.round(Number(t) * 1000), count: Number(count) || 0 }))
        return { pattern: item.pattern, level: item.level || undefined, samples, count: samples.reduce((sum, sample) => sum + sample.count, 0) }
      })
      .sort((a, b) => b.count - a.count)
  } catch (error) {
    if (isMissingEndpoint(error)) return null
    throw error
  }
}

export interface DetectedLabel {
  label: string
  cardinality: number
}

/** Labels Loki detected for a selector with their cardinality (Loki 3.x). Null when unsupported. */
export async function fetchDetectedLabels(connection: Connection, selector: SelectorInput, options: CallOptions = {}): Promise<DetectedLabel[] | null> {
  try {
    const body = await raw<{ detectedLabels?: DetectedLabel[] }>(connection, "/detected_labels", { query: selectorText(selector), ...timeQuery(options.range) }, options.signal)
    return (body.detectedLabels ?? []).map((item) => ({ label: item.label, cardinality: Number(item.cardinality) || 0 }))
  } catch (error) {
    if (isMissingEndpoint(error)) return null
    throw error
  }
}

/** Loki's version, or null when buildinfo isn't exposed (Grafana Cloud hides it). */
export async function fetchLokiBuildInfo(connection: Connection, signal?: AbortSignal): Promise<{ version: string | null } | null> {
  try {
    const body = await raw<{ version?: string; data?: { version?: string } }>(connection, "/status/buildinfo", {}, signal)
    return { version: body.version ?? body.data?.version ?? null }
  } catch (error) {
    if (isAbort(error)) throw error
    return null
  }
}

export interface LokiCheck {
  version: string | null
  latencyMs: number
  labelCount: number
  /** index/volume answered; without it Cardinal can't measure bytes. */
  volumeApi: boolean
}

/**
 * Connection test: the label list proves URL, auth and the Loki API; buildinfo
 * adds the version where exposed; one small index/volume call checks that the
 * volume API (Loki ≥ 2.9, volume_enabled) exists.
 */
export async function testLokiConnection(connection: Connection, signal?: AbortSignal): Promise<LokiCheck> {
  const started = performance.now()
  const range = timeRangeFor("1h")
  const labels = (await fetchLokiLabels(connection, { range, signal })).filter((label) => !isInternalLabel(label))
  const latencyMs = Math.round(performance.now() - started)
  const build = await fetchLokiBuildInfo(connection, signal)
  let volumeApi = false
  const group = pickGroupLabel(labels)
  if (group) {
    try {
      await fetchIndexVolume(connection, { text: anyValueSelector(group) }, { range, limit: 1, signal })
      volumeApi = true
    } catch (error) {
      if (isAbort(error)) throw error
      if (!(error instanceof HttpError) || error.status === 401) throw error
    }
  }
  return { version: build?.version ?? null, latencyMs, labelCount: labels.length, volumeApi }
}

export interface LogsSnapshotOptions {
  range: LogsRange
  /** The label to group streams by; auto-picked when unset or missing. */
  groupLabel?: string
  signal?: AbortSignal
  onStep?: (progress: LogsSnapshotProgress) => void
  onProgress?: (message: string) => void
  now?: number
}

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * The logs snapshot: totals from index/stats, bytes per group from
 * index/volume, streams for the top groups from index/stats, and distinct
 * values per label. About 2 + groups + labels requests, four at a time.
 */
export async function fetchLogsSnapshot(connection: Connection, options: LogsSnapshotOptions): Promise<LogsSnapshot> {
  const { signal } = options
  const step = options.onStep ?? (() => undefined)
  const range = timeRangeFor(options.range, options.now)

  step({ done: 0, total: 0, phase: "Listing labels" })
  const labels = (await fetchLokiLabels(connection, { range, signal })).filter((label) => !isInternalLabel(label))
  const groupLabel = pickGroupLabel(labels, options.groupLabel)
  if (!groupLabel) throw new Error(`No log streams in the last ${options.range}.`)
  const selector = anyValueSelector(groupLabel)
  options.onProgress?.(`Grouping streams by ${groupLabel}`)

  step({ done: 0, total: 0, phase: "Measuring volume" })
  const [totals, volume] = await Promise.all([
    fetchIndexStats(connection, { text: selector }, { range, signal }),
    fetchIndexVolume(connection, { text: selector }, { range, targetLabels: [groupLabel], limit: 1000, signal }),
  ])
  const volumes = volume.map((row) => ({ value: row.labels[groupLabel] ?? "", bytes: row.bytes })).filter((row) => row.value !== "")
  const topGroups = volumes.slice(0, MAX_GROUPS)

  const total = topGroups.length + labels.length
  let done = 0
  const tick = (phase: string) => {
    done += 1
    step({ done, total, phase })
  }
  step({ done, total, phase: "Counting streams" })
  const streamsByGroup: Record<string, number> = Object.create(null)
  await runWithConcurrency(
    topGroups,
    async (group) => {
      try {
        const stats = await fetchIndexStats(connection, [{ label: groupLabel, op: "=", value: group.value }], { range, signal })
        streamsByGroup[group.value] = stats.streams
      } finally {
        tick("Counting streams")
      }
    },
    CONCURRENCY,
    signal
  )

  const labelValues = await runWithConcurrency(
    labels,
    async (label) => {
      try {
        const values = await fetchLokiLabelValues(connection, label, { range, selector: { text: selector }, signal })
        return { label, values: values.slice(0, MAX_LABEL_VALUES) }
      } catch (error) {
        if (isAbort(error) || (error instanceof HttpError && (error.status === 401 || error.status === 403))) throw error
        options.onProgress?.(`Could not list values of ${label}: ${error instanceof Error ? error.message : String(error)}`)
        return { label, values: [] }
      } finally {
        tick("Reading label values")
      }
    },
    CONCURRENCY,
    signal
  )

  return buildLogsSnapshot({
    host: hostOf(connection.baseUrl),
    range: options.range,
    groupLabel,
    selector,
    totals: { streams: totals.streams, bytes: totals.bytes, lines: totals.entries },
    volumes,
    streamsByGroup,
    labels: labelValues.filter((item) => item.values.length > 0),
  })
}

/** Total bytes per step over the range, summed across groups. */
export async function fetchLogsVolumeHistory(
  connection: Connection,
  groupLabel: string,
  range: LogsRange,
  signal?: AbortSignal
): Promise<{ points: Array<{ t: number; value: number }>; stepSeconds: number }> {
  const stepSeconds = volumeStepSeconds(range)
  // Aligned to the step so cached results line up across refetches.
  const end = Math.floor(Date.now() / (stepSeconds * 1000)) * stepSeconds * 1000
  const series = await fetchIndexVolumeRange(connection, { text: anyValueSelector(groupLabel) }, {
    range: { start: end - LOGS_RANGE_SECONDS[range] * 1000, end },
    targetLabels: [groupLabel],
    limit: 1000,
    stepSeconds,
    signal,
  })
  // The newest bucket also counts chunks still being written, so it overshoots: leave it out.
  const points = sumVolumeSeries(series).filter((point) => point.t < end - 1000)
  return { points, stepSeconds }
}
