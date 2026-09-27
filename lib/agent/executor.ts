import { runWithConcurrency } from "@/lib/core/concurrency"
import { compileAdaptiveMetrics, renderAdaptiveMetrics } from "@/lib/core/compile/adaptive-metrics"
import { renderAlloy } from "@/lib/core/compile/alloy"
import { planRelabel } from "@/lib/core/compile/plan"
import { renderPrometheus } from "@/lib/core/compile/prometheus"
import { regexProblem } from "@/lib/core/regex"
import { createRule, normalizeBuckets, type Rule, type RuleImpact } from "@/lib/core/rules"
import { snapshotImpact } from "@/lib/core/savings"
import { jobsByMetric } from "@/lib/core/snapshot"
import { isToolName, toolDefinitions, type RuleSpec, type ToolArgs, type ToolName } from "@/lib/agent/tools"
import { logHandlers, logsSessionInfo } from "@/lib/agent/logs-executor"
import { fetchRecommendations, isGrafanaCloud } from "@/lib/sources/adaptive-metrics"
import { churnReport } from "@/lib/sources/churn"
import { histogramReport } from "@/lib/sources/histograms"
import {
  fetchMetricDrilldown,
  fetchRuleUsage,
  fetchSeriesByJob,
  fetchSnapshot,
  fetchTopLabelValues,
} from "@/lib/sources/prometheus"
import { measureRuleImpact } from "@/hooks/use-rule-impacts"
import { attributionReport } from "@/lib/sources/attribution"
import { ATTRIBUTION_DISABLED_MESSAGE } from "@/lib/core/attribution"
import { checkDashboardUsage, dashboardUsageCounts } from "@/features/usage/agent"
import type { Connection } from "@/lib/sources/transport"
import { currentConnection, useAppStore } from "@/lib/store/app-store"

// Executes MCP tool calls relayed from the session Durable Object, inside the
// tab, with the user's connection. Results are compact JSON for agent context.

function requireConnection(): Connection {
  const connection = currentConnection()
  if (!connection) throw new Error("Cardinal is not connected to a backend. Ask the user to connect first.")
  return connection
}

function requireSnapshot() {
  const snapshot = useAppStore.getState().snapshot
  if (!snapshot) throw new Error("No snapshot loaded yet. Call refresh_snapshot.")
  return snapshot
}

/** get_attribution (and its deprecated alias get_teams). */
async function attribution(topOwners: number, topMetrics: number, signal?: AbortSignal) {
  const { attribution: settings, rules, drilldowns, settings: connectionSettings } = useAppStore.getState()
  if (!settings.enabled) return { disabled: true, message: ATTRIBUTION_DISABLED_MESSAGE }
  const snapshot = requireSnapshot()
  return attributionReport(
    requireConnection(),
    { settings, snapshot, rules, drilldowns, pricePer1k: connectionSettings.pricePer1kSeries, topOwners, topMetrics },
    signal
  )
}

const pct = (part: number, total: number) => (total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0)

function specToRule(spec: RuleSpec, origin: Rule["origin"], status: Rule["status"]): Rule {
  const selector = spec.job !== undefined ? { metric: spec.metric, job: spec.job } : { metric: spec.metric }
  if (spec.kind === "drop_labels") {
    if (!spec.labels?.length) throw new Error(`drop_labels rule for ${spec.metric} needs labels`)
    return createRule({ kind: "drop_labels", selector, labels: spec.labels, origin, status, rationale: spec.rationale })
  }
  if (spec.kind === "drop_series") {
    if (!spec.match) throw new Error(`drop_series rule for ${spec.metric} needs match {label, regex}`)
    const problem = regexProblem(spec.match.regex)
    if (problem) throw new Error(`drop_series regex for ${spec.metric} is invalid: ${problem}`)
    return createRule({ kind: "drop_series", selector, match: spec.match, origin, status, rationale: spec.rationale })
  }
  if (spec.kind === "keep_buckets") {
    if (!spec.metric.endsWith("_bucket")) throw new Error(`keep_buckets needs a _bucket metric, got ${spec.metric}`)
    if (!spec.buckets?.length) throw new Error(`keep_buckets rule for ${spec.metric} needs buckets`)
    return createRule({ kind: "keep_buckets", selector, buckets: normalizeBuckets(spec.buckets), origin, status, rationale: spec.rationale })
  }
  return createRule({ kind: "drop_metric", selector, origin, status, rationale: spec.rationale })
}

function describeRule(rule: Rule) {
  return {
    id: rule.id,
    kind: rule.kind,
    metric: rule.selector.metric,
    job: rule.selector.job,
    labels: rule.kind === "drop_labels" ? rule.labels : undefined,
    match: rule.kind === "drop_series" ? rule.match : undefined,
    buckets: rule.kind === "keep_buckets" ? rule.buckets : undefined,
    status: rule.status,
    origin: rule.origin,
    rationale: rule.rationale,
    impact: rule.impact && describeImpact(rule.impact),
  }
}

function describeImpact(impact: RuleImpact) {
  const total = useAppStore.getState().snapshot?.totalSeries ?? 0
  const saved = impact.seriesBefore - impact.seriesAfter
  return {
    series_before: impact.seriesBefore,
    series_after: impact.seriesAfter,
    series_saved: saved,
    percent_of_total: pct(saved, total),
    merges_series: impact.mergesSeries,
  }
}

export interface ExecuteOptions {
  /** Aborted when the session Durable Object gives up on the call. */
  signal?: AbortSignal
}

type Handlers = { [K in ToolName]: (args: ToolArgs<K>, options: ExecuteOptions) => Promise<unknown> }

/** Rejects as soon as `signal` aborts, without cancelling the shared work behind `promise`. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

interface SnapshotSummary {
  total_series: number
  metrics: number
  jobs: number
  note?: string
  skipped_jobs?: string[]
  jobs_capped_at_500_metrics?: string[]
}

// Concurrent refresh_snapshot calls join one in-flight refresh. It is aborted
// only once every caller waiting on it has been cancelled.
let snapshotRefresh: { promise: Promise<SnapshotSummary>; controller: AbortController; waiters: number } | null = null

function refreshSnapshotShared(signal?: AbortSignal): Promise<SnapshotSummary> {
  signal?.throwIfAborted()
  if (!snapshotRefresh) {
    const connection = requireConnection()
    const { settings, setSnapshot, setSnapshotProgress, log } = useAppStore.getState()
    const controller = new AbortController()
    log("Agent requested a snapshot refresh")
    const promise: Promise<SnapshotSummary> = fetchSnapshot(connection, settings.topN, {
      onProgress: log,
      onStep: setSnapshotProgress,
      signal: controller.signal,
    })
      .then((snapshot) => {
        setSnapshot(snapshot)
        return {
          total_series: snapshot.totalSeries,
          metrics: snapshot.metricCount,
          jobs: snapshot.jobs.length,
          ...(snapshot.method === "per-job"
            ? {
                note: "The backend refused the full count (query limit), so jobs were counted one by one.",
                skipped_jobs: snapshot.skippedJobs,
                jobs_capped_at_500_metrics: snapshot.truncatedJobs,
              }
            : {}),
        }
      })
      .finally(() => {
        setSnapshotProgress(null)
        if (snapshotRefresh?.promise === promise) snapshotRefresh = null
      })
    snapshotRefresh = { promise, controller, waiters: 0 }
  }
  const shared = snapshotRefresh
  shared.waiters += 1
  signal?.addEventListener(
    "abort",
    () => {
      shared.waiters -= 1
      if (shared.waiters === 0) shared.controller.abort(signal.reason)
    },
    { once: true }
  )
  return untilAborted(shared.promise, signal)
}

const handlers: Handlers = {
  async get_session_info() {
    const { settings, snapshot, rules } = useAppStore.getState()
    const connection = currentConnection(settings)
    return {
      connected: Boolean(connection),
      backend: connection ? new URL(connection.baseUrl).host : null,
      grafana_cloud: connection ? isGrafanaCloud(connection) : false,
      capabilities: {
        adaptive_metrics: connection ? isGrafanaCloud(connection) : false,
        prometheus_rules_api: Boolean(connection),
        label_values: useAppStore.getState().agentShareLabelValues,
      },
      snapshot: snapshot
        ? {
            captured_at: snapshot.capturedAt ?? null,
            partial: snapshot.method === "per-job" && Boolean(snapshot.skippedJobs?.length || snapshot.truncatedJobs?.length),
            total_series: snapshot.totalSeries,
            metrics: snapshot.metricCount,
            jobs: snapshot.jobs.length,
          }
        : null,
      rules: {
        active: rules.filter((rule) => rule.status === "active").length,
        proposed: rules.filter((rule) => rule.status === "proposed").length,
      },
      signals: {
        metrics: { connected: Boolean(connection) },
        logs: logsSessionInfo(),
      },
    }
  },

  async refresh_snapshot(_args, { signal }) {
    return refreshSnapshotShared(signal)
  },

  async get_overview({ limit }) {
    const snapshot = requireSnapshot()
    return {
      total_series: snapshot.totalSeries,
      metric_count: snapshot.metricCount,
      label_count: snapshot.labelCount,
      captured_at: snapshot.capturedAt ?? null,
      top_metrics: snapshot.metrics.slice(0, limit).map((metric) => ({
        metric: metric.metric,
        series: metric.seriesCount,
        percent: metric.percentageOfTotal,
        jobs: metric.jobs?.slice(0, 5),
      })),
      top_jobs: snapshot.jobs.slice(0, limit).map((job) => ({
        job: job.job,
        series: job.seriesCount,
        percent: job.percentageOfTotal,
        metrics: job.metricCount,
      })),
    }
  },

  async list_metrics({ job, contains, min_series, offset, limit }) {
    const snapshot = requireSnapshot()
    const needle = contains?.toLowerCase()
    const matches = snapshot.metrics.filter(
      (metric) =>
        (job === undefined || metric.jobs?.includes(job)) &&
        (!needle || metric.metric.toLowerCase().includes(needle)) &&
        (min_series === undefined || metric.seriesCount >= min_series)
    )
    return {
      total_matches: matches.length,
      offset,
      metrics: matches.slice(offset, offset + limit).map((metric) => ({
        metric: metric.metric,
        series: metric.seriesCount,
        percent: metric.percentageOfTotal,
        top_job: metric.topJob,
      })),
    }
  },

  async get_metric_breakdown({ metric, job }, { signal }) {
    const connection = requireConnection()
    const [drilldown, byJob] = await Promise.all([
      fetchMetricDrilldown(connection, metric, { job, signal }),
      fetchSeriesByJob(connection, metric, signal),
    ])
    if (job === undefined) useAppStore.getState().cacheDrilldown(drilldown)
    return {
      metric,
      job: job ?? null,
      series: drilldown.seriesCount,
      labels: drilldown.labels.map((label) => ({ label: label.label, distinct_values: label.cardinality })),
      series_by_job: byJob.slice(0, 20),
    }
  },

  async get_label_values({ metric, label, job, limit }, { signal }) {
    if (!useAppStore.getState().agentShareLabelValues) {
      throw new Error(
        "The user disabled sharing label values with the agent in Cardinal. Use get_metric_breakdown (label names and distinct-value counts) instead, and don't retry this tool."
      )
    }
    const values = await fetchTopLabelValues(requireConnection(), metric, label, { job, limit, signal })
    return { metric, label, values: values.map((item) => ({ value: item.value, series: item.seriesCount })) }
  },

  async check_usage({ metrics }, { signal }) {
    const connection = requireConnection()
    const [ruleUsage, recommendations, dashboards] = await Promise.all([
      fetchRuleUsage(connection, metrics, signal).catch((error: Error) => ({ error: error.message })),
      isGrafanaCloud(connection) ? fetchRecommendations(connection, { signal }).catch(() => null) : Promise.resolve(null),
      dashboardUsageCounts(metrics),
    ])
    signal?.throwIfAborted()
    const recByMetric = new Map(recommendations?.map((rec) => [rec.metric, rec]))
    return metrics.map((metric) => {
      const rec = recByMetric.get(metric)
      return {
        metric,
        prometheus_rules: "error" in ruleUsage ? ruleUsage.error : ruleUsage[metric],
        grafana_cloud_usage: rec
          ? {
              dashboards: rec.usages_in_dashboards ?? 0,
              queries: rec.usages_in_queries ?? 0,
              rules: rec.usages_in_rules ?? 0,
            }
          : null,
        grafana_dashboards: dashboards ? dashboards[metric] : "not scanned (see check_dashboard_usage)",
      }
    })
  },

  async check_dashboard_usage({ metric, labels }) {
    return checkDashboardUsage(metric, labels)
  },

  async estimate_impact({ rules }, { signal }) {
    const connection = requireConnection()
    const results = await runWithConcurrency(
      rules,
      async (spec) => {
        const rule = specToRule(spec, "agent", "proposed")
        try {
          signal?.throwIfAborted()
          return { rule: spec, ...describeImpact(await measureRuleImpact(connection, rule, signal)) }
        } catch (error) {
          return { rule: spec, error: error instanceof Error ? error.message : String(error) }
        }
      },
      4
    )
    signal?.throwIfAborted()
    const saved = results.reduce((sum, item) => sum + ("series_saved" in item ? item.series_saved : 0), 0)
    return {
      results,
      combined_upper_bound_series_saved: saved,
      note: "Rules on the same metric overlap; the combined figure is an upper bound.",
    }
  },

  async get_adaptive_recommendations({ action, limit }, { signal }) {
    const connection = requireConnection()
    if (!isGrafanaCloud(connection)) throw new Error("Adaptive Metrics is only available for Grafana Cloud connections")
    const recommendations = await fetchRecommendations(connection, { actions: action ? [action] : undefined, signal })
    const ranked = recommendations
      .map((rec) => ({
        ...rec,
        saved: (rec.total_series_before_aggregation ?? 0) - (rec.total_series_after_aggregation ?? 0),
      }))
      .sort((a, b) => b.saved - a.saved)
    return {
      total: recommendations.length,
      recommendations: ranked.slice(0, limit).map((rec) => ({
        metric: rec.metric,
        action: rec.recommended_action,
        drop: rec.drop,
        drop_labels: rec.drop_labels,
        kept_labels: rec.kept_labels,
        aggregations: rec.aggregations,
        series_before: rec.total_series_before_aggregation,
        series_after: rec.total_series_after_aggregation,
        usage: { dashboards: rec.usages_in_dashboards, queries: rec.usages_in_queries, rules: rec.usages_in_rules },
      })),
    }
  },

  async get_attribution({ top_owners, top_metrics }, { signal }) {
    return attribution(top_owners, top_metrics, signal)
  },

  async get_teams({ top_owners, top_metrics }, { signal }) {
    return attribution(top_owners, top_metrics, signal)
  },

  async get_rules() {
    return useAppStore.getState().rules.filter((rule) => rule.status !== "rejected").map(describeRule)
  },

  async propose_rules({ rules: specs, summary }, { signal }) {
    const connection = requireConnection()
    const { addRules, log, snapshot } = useAppStore.getState()
    const rules = specs.map((spec) =>
      specToRule({ ...spec, rationale: spec.rationale ?? summary }, "agent", "proposed")
    )
    await runWithConcurrency(
      rules,
      async (rule) => {
        if (signal?.aborted) return
        // Metric drops are exact from the snapshot; only label drops need a query.
        const fromSnapshot = snapshotImpact(rule, snapshot)
        rule.impact = fromSnapshot ?? (await measureRuleImpact(connection, rule, signal).catch(() => undefined))
      },
      4
    )
    // A cancelled call must not leave proposals behind that the agent never saw.
    signal?.throwIfAborted()
    const { added, skipped } = addRules(rules)
    log(`Agent proposed ${added} rule${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already covered)` : ""}: ${summary}`)
    return {
      proposed: rules.map(describeRule),
      added,
      skipped_as_duplicates: skipped,
      message: skipped
        ? "Proposals are pending in the user's Cardinal tab for review. Some were skipped because an active or pending rule already covers them."
        : "Proposals are pending in the user's Cardinal tab for review.",
    }
  },

  async get_histograms({ limit }, { signal }) {
    const snapshot = requireSnapshot()
    return histogramReport(requireConnection(), snapshot.metrics, { limit, totalSeries: snapshot.totalSeries, signal })
  },

  async render_config({ format, include_proposed, mode }) {
    const { rules, snapshot } = useAppStore.getState()
    const selected = rules
      .filter((rule) => rule.status === "active" || (include_proposed && rule.status === "proposed"))
      .map((rule) => ({ ...rule, status: "active" as const }))
    if (format === "adaptive-metrics") {
      const result = compileAdaptiveMetrics(selected)
      return { config: renderAdaptiveMetrics(result), warnings: result.warnings }
    }
    const plan = planRelabel(selected, { mode, jobsByMetric: snapshot ? jobsByMetric(snapshot) : undefined })
    return { config: format === "prometheus" ? renderPrometheus(plan) : renderAlloy(plan), warnings: plan.warnings }
  },

  async get_churn({ window, job, metric, limit }, { signal }) {
    const { snapshot, settings } = useAppStore.getState()
    const jobs = snapshot?.jobs.map((item) => item.job)
    return churnReport(requireConnection(), { window, job, metric, limit, jobs, pricePer1kSeries: settings.pricePer1kSeries, signal })
  },

  ...logHandlers,
}

/** Thrown for every call while the user has paused the agent. */
export const PAUSED_MESSAGE =
  "Paused by user: the Cardinal user paused agent access. The session is still open; wait and try again later, or ask the user to resume."

export async function executeTool(tool: string, rawArgs: unknown, options: ExecuteOptions = {}): Promise<unknown> {
  if (useAppStore.getState().agentPaused) throw new Error(PAUSED_MESSAGE)
  if (!isToolName(tool)) throw new Error(`Unknown tool: ${tool}`)
  const args = toolDefinitions[tool].input.parse(rawArgs ?? {})
  options.signal?.throwIfAborted()
  return (handlers[tool] as (args: unknown, options: ExecuteOptions) => Promise<unknown>)(args, options)
}
