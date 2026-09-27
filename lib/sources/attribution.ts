import {
  ATTRIBUTION_DISABLED_MESSAGE,
  attributionChain,
  attributionQueries,
  attributionSummary,
  breakdownLabel,
  buildAttribution,
  type Attribution,
  type AttributionSettings,
  type ChainRow,
  type OwnerDrilldown,
} from "@/lib/core/attribution"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { ownerRuleQueries, queryableLabelRules, snapshotCells, type LabelRuleRows, type Owner } from "@/lib/core/owner-rules"
import type { Rule } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import type { JobMetricSeries, MetricDrilldown, PrometheusResponse } from "@/lib/prometheus/types"
import { isQueryLimitError, type SnapshotProgress } from "@/lib/sources/prometheus"
import { HttpError, sendJson, type Connection } from "@/lib/sources/transport"

// Queries behind attribution (built by lib/core/attribution.ts and
// lib/core/owner-rules.ts from validated names and escaped values only).

interface VectorSample {
  metric: Record<string, string>
  value: [number, string]
}

async function instant(connection: Connection, query: string, signal?: AbortSignal) {
  const payload = await sendJson<PrometheusResponse<{ result: VectorSample[] }>>(connection, {
    path: "/api/v1/query",
    query: { query },
    signal,
  })
  if (payload.status !== "success" || payload.data === undefined) {
    throw new Error(payload.error ?? "Prometheus API returned an error")
  }
  return payload.data.result
}

const count = (sample: VectorSample) => Number(sample.value[1]) || 0

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

export interface PerJobOptions {
  signal?: AbortSignal
  /** Jobs to fall back to when one query is too large (the snapshot's jobs). */
  jobs?: string[]
  onStep?: (progress: SnapshotProgress) => void
}

export interface PerJobResult<T> {
  rows: T[]
  /** Jobs that could not be counted even on their own. */
  skippedJobs: string[]
  /** True when the whole query was too large and ran job by job. */
  perJob: boolean
}

/**
 * Runs `query()` once; when the backend refuses it for its size, runs
 * `query(job)` per job (like the snapshot does), reporting progress.
 */
async function withPerJobFallback<T>(
  connection: Connection,
  query: (job?: string) => string,
  map: (sample: VectorSample, job?: string) => T,
  { signal, jobs = [], onStep }: PerJobOptions
): Promise<PerJobResult<T>> {
  try {
    const rows = await instant(connection, query(), signal)
    return { rows: rows.map((row) => map(row)), skippedJobs: [], perJob: false }
  } catch (error) {
    if (isAbort(error) || !isQueryLimitError(error) || jobs.length === 0) throw error
  }
  const list = ["", ...jobs.filter((job) => job !== "")]
  const skippedJobs: string[] = []
  let done = 0
  onStep?.({ done, total: list.length, phase: "Querying jobs" })
  const perJob = await runWithConcurrency(
    list,
    async (job): Promise<T[]> => {
      try {
        const rows = await instant(connection, query(job), signal)
        return rows.map((row) => map(row, job))
      } catch (error) {
        if (isAbort(error) || (error instanceof HttpError && (error.status === 401 || error.status === 403))) throw error
        skippedJobs.push(job)
        return []
      } finally {
        done += 1
        onStep?.({ done, total: list.length, phase: "Querying jobs" })
      }
    },
    4,
    signal
  )
  return { rows: perJob.flat(), skippedJobs, perJob: true }
}

/** `count by (chain)` rows; rows from a per-job fallback repeat combinations, which resolution sums. */
export function fetchChainRows(connection: Connection, chain: string[], options: PerJobOptions = {}) {
  return withPerJobFallback<ChainRow>(
    connection,
    (job) => attributionQueries.seriesByChain(chain, job),
    (sample) => ({ labels: Object.fromEntries(chain.map((label) => [label, sample.metric[label] ?? ""])), seriesCount: count(sample) }),
    options
  )
}

/** Job×metric counts of series without any attribution label. */
export function fetchUnlabelledCells(connection: Connection, chain: string[], options: PerJobOptions = {}) {
  return withPerJobFallback<JobMetricSeries>(
    connection,
    (job) => attributionQueries.unlabelledByJobMetric(chain, job),
    (sample, job) => ({ job: job ?? sample.metric.job ?? "", metric: sample.metric.__name__ ?? "unknown", seriesCount: count(sample) }),
    options
  )
}

/** `count by (job, chain)` rows for the owner badges on jobs. */
export async function fetchJobChainRows(connection: Connection, chain: string[], signal?: AbortSignal): Promise<ChainRow[]> {
  const rows = await instant(connection, attributionQueries.seriesByJobAndChain(chain), signal)
  return rows.map((sample) => ({
    labels: Object.fromEntries(["job", ...chain].map((label) => [label, sample.metric[label] ?? ""])),
    seriesCount: count(sample),
  }))
}

/** A label owner's top metrics and its breakdown by the next attribution label (or job). */
export async function fetchOwnerDrilldown(
  connection: Connection,
  chain: string[],
  dimension: number,
  value: string,
  signal?: AbortSignal
): Promise<OwnerDrilldown> {
  const label = breakdownLabel(chain, dimension)
  const [metrics, breakdown] = await Promise.all([
    instant(connection, attributionQueries.ownerTopMetrics(chain, dimension, value), signal),
    instant(connection, attributionQueries.ownerBreakdown(chain, dimension, value), signal),
  ])
  const sorted = <T extends { series: number }>(items: T[]) => items.sort((a, b) => b.series - a.series)
  return {
    metrics: sorted(metrics.map((sample) => ({ metric: sample.metric.__name__ ?? "unknown", series: count(sample) }))),
    breakdown: { label, values: sorted(breakdown.map((sample) => ({ value: sample.metric[label] ?? "", series: count(sample) }))) },
  }
}

export interface LabelValueSeries {
  /** "" = series without the label. */
  value: string
  seriesCount: number
}

export async function fetchSeriesByLabelValue(
  connection: Connection,
  label: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<LabelValueSeries[]> {
  const rows = await instant(connection, ownerRuleQueries.seriesByLabelValue(label, options.limit ?? 50), options.signal)
  return rows.map((row) => ({ value: row.metric[label] ?? "", seriesCount: count(row) })).sort((a, b) => b.seriesCount - a.seriesCount)
}

export async function fetchLabelRuleRows(
  connection: Connection,
  chain: string[],
  rule: { label: string; pattern: string },
  signal?: AbortSignal
): Promise<JobMetricSeries[]> {
  const rows = await instant(connection, ownerRuleQueries.seriesMatchingLabel(rule.label, rule.pattern, chain), signal)
  return rows.map((row) => ({ job: row.metric.job ?? "", metric: row.metric.__name__ ?? "unknown", seriesCount: count(row) }))
}

/** Rows for every label rule of the owners; failed rules are reported, not thrown. */
export async function fetchAllLabelRuleRows(connection: Connection, chain: string[], owners: Owner[], signal?: AbortSignal) {
  const rows: LabelRuleRows = {}
  const errors: Record<string, string> = {}
  await runWithConcurrency(
    queryableLabelRules(owners),
    async (rule) => {
      try {
        rows[rule.key] = await fetchLabelRuleRows(connection, chain, rule, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        errors[rule.key] = error instanceof Error ? error.message : String(error)
      }
    },
    4,
    signal
  )
  return { rows, errors }
}

/** Everything the agent needs in one go: chain rows, unlabelled cells and label rules. */
export async function fetchAttribution(
  connection: Connection,
  settings: AttributionSettings,
  snapshot: Snapshot,
  options: Omit<PerJobOptions, "jobs"> = {}
): Promise<{ attribution: Attribution; labelRuleErrors: Record<string, string>; skippedJobs: string[] }> {
  const chain = attributionChain(settings.labels)
  const jobs = snapshot.jobs.map((job) => job.job)
  const [chainRows, unlabelled, labelRules] = await Promise.all([
    chain.length ? fetchChainRows(connection, chain, { ...options, jobs }) : null,
    chain.length ? fetchUnlabelledCells(connection, chain, { ...options, jobs }) : null,
    fetchAllLabelRuleRows(connection, chain, settings.owners, options.signal),
  ])
  const attribution = buildAttribution({
    chain,
    chainRows: chainRows?.rows,
    unlabelled: unlabelled ? { cells: unlabelled.rows, exact: true } : snapshotCells(snapshot),
    owners: settings.owners,
    labelRows: labelRules.rows,
  })
  const skippedJobs = [...new Set([...(chainRows?.skippedJobs ?? []), ...(unlabelled?.skippedJobs ?? [])])]
  return { attribution, labelRuleErrors: labelRules.errors, skippedJobs }
}

/** The agent's get_attribution result: owners with cost, savings and (for the largest label owners) top metrics. */
export async function attributionReport(
  connection: Connection,
  input: {
    settings: AttributionSettings
    snapshot: Snapshot
    rules: Rule[]
    drilldowns: Record<string, MetricDrilldown>
    pricePer1k?: number
    topOwners: number
    topMetrics: number
  },
  signal?: AbortSignal
) {
  if (!input.settings.enabled) return { disabled: true, message: ATTRIBUTION_DISABLED_MESSAGE }
  const { attribution, labelRuleErrors, skippedJobs } = await fetchAttribution(connection, input.settings, input.snapshot, { signal })
  const labelOwners = [...attribution.owners]
    .sort((a, b) => b.series - a.series)
    .slice(0, input.topOwners)
    .filter((owner) => owner.source === "label")
  const ownerDrilldowns: Record<string, OwnerDrilldown> = {}
  await runWithConcurrency(
    labelOwners,
    async (owner) => {
      try {
        ownerDrilldowns[owner.id] = await fetchOwnerDrilldown(connection, attribution.chain, owner.dimension!, owner.name, signal)
      } catch (error) {
        if (signal?.aborted) throw error
      }
    },
    4,
    signal
  )
  const summary = attributionSummary(input.snapshot, input.settings, attribution, input.rules, input.drilldowns, {
    pricePer1k: input.pricePer1k,
    topOwners: input.topOwners,
    topMetrics: input.topMetrics,
    ownerDrilldowns,
    labelRuleErrors,
  })
  return skippedJobs.length ? { ...summary, skipped_jobs: skippedJobs } : summary
}
