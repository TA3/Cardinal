import type { logToolDefinitions, LogRuleSpec } from "@/lib/agent/tools"
import { fetchLokiRuleQueries, lokiRulesErrorText } from "@/features/rules/log-usage"
import { logqlScanEvidence, readLogqlIndex } from "@/features/usage/logql-scan"
import { measureLogRuleImpact } from "@/hooks/use-log-rule-impacts"
import { formatBytes } from "@/lib/core/bytes"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { detectIdLike } from "@/lib/core/id-like"
import { hasAdaptiveLogs, fetchLogRecommendations } from "@/lib/sources/adaptive-logs"
import { recommendationRows } from "@/lib/core/logs/adaptive-apply"
import { summarizeLogRule } from "@/lib/core/logs/logql-usage"
import { compileAdaptiveLogs } from "@/lib/core/logs/compile/adaptive-logs"
import { compileAlloyLogs } from "@/lib/core/logs/compile/alloy"
import { compileLokiLimits } from "@/lib/core/logs/compile/loki-limits"
import { compilePromtailLogs } from "@/lib/core/logs/compile/promtail"
import { computeLogSavings, snapshotLogImpact } from "@/lib/core/logs/impact"
import { createLogRule, describeLogRule, logRuleProblem, logRuleSelector, type LogRuleInput } from "@/lib/core/logs/rules"
import { bytesPerDay, LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogRule, LogRuleImpact, LogsRange, LogsSnapshot } from "@/lib/core/logs/types"
import { anyValueSelector, streamSelector } from "@/lib/core/logql"
import {
  fetchIndexStats,
  fetchIndexVolume,
  fetchLogsSnapshot,
  fetchLokiLabels,
  fetchLokiLabelValues,
  fetchPatterns,
  timeRangeFor,
} from "@/lib/sources/loki"
import type { Connection } from "@/lib/sources/transport"
import { currentConnection, useAppStore } from "@/lib/store/app-store"
import type { z } from "zod"

// MCP tools for logs (Loki), run in the tab like lib/agent/executor.ts. Label
// values of labels other than the group label, patterns and sample lines count
// as sharing values and respect the user's "Share label values" switch.

type LogToolName = keyof typeof logToolDefinitions
type Args<K extends LogToolName> = z.infer<(typeof logToolDefinitions)[K]["input"]>
export type LogHandlers = { [K in LogToolName]: (args: Args<K>, options: { signal?: AbortSignal }) => Promise<unknown> }

export const SHARING_OFF_MESSAGE =
  "The user disabled sharing label values with the agent in Cardinal. Label values of that label, log patterns and sample lines are not shared; work from get_log_labels (names and distinct-value counts) and get_logs_overview instead, and don't retry this tool."

function requireLogsConnection(): Connection {
  const connection = currentConnection("logs")
  if (!connection) throw new Error("Cardinal has no logs (Loki) connection. Ask the user to connect one on the Logs overview.")
  return connection
}

function requireLogsSnapshot(): LogsSnapshot {
  const snapshot = useAppStore.getState().logsSnapshot
  if (!snapshot) throw new Error("No logs snapshot yet. Call refresh_logs_snapshot.")
  return snapshot
}

function requireSharing() {
  if (!useAppStore.getState().agentShareLabelValues) throw new Error(SHARING_OFF_MESSAGE)
}

const rangeDays = (range: LogsRange) => LOGS_RANGE_SECONDS[range] / 86400
const pct = (part: number, total: number) => (total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0)

/** A spec as a rule input; throws with the reason when it is invalid. */
export function logSpecToRule(spec: LogRuleSpec, origin: LogRule["origin"], status: LogRule["status"]): LogRule {
  const common = { selector: { matchers: spec.selector }, origin, status, rationale: spec.rationale }
  const need = (value: unknown, field: string) => {
    if (value === undefined) throw new Error(`${spec.kind} needs ${field}`)
  }
  let input: LogRuleInput
  switch (spec.kind) {
    case "drop_streams":
      input = { ...common, kind: "drop_streams" }
      break
    case "drop_lines":
      need(spec.line, "line {regex | levels}")
      input = { ...common, kind: "drop_lines", line: spec.line! }
      break
    case "sample":
      need(spec.keep, "keep (0–1)")
      input = { ...common, kind: "sample", keep: spec.keep!, ...(spec.line ? { line: spec.line } : {}) }
      break
    case "drop_label":
    case "label_to_metadata":
      need(spec.label, "label")
      input = { ...common, kind: spec.kind, label: spec.label! }
      break
    case "retention":
      need(spec.days, "days")
      input = { ...common, kind: "retention", days: spec.days! }
      break
    case "keep":
      need(spec.rationale, "rationale")
      input = { ...common, kind: "keep", ...(spec.line ? { line: spec.line } : {}) }
      break
  }
  const problem = logRuleProblem(input)
  if (problem) throw new Error(`Invalid log rule (${spec.kind}): ${problem}`)
  return createLogRule(input)
}

function describeImpact(impact: LogRuleImpact, range: LogsRange, snapshot: LogsSnapshot | null) {
  const saved = Math.max(0, impact.bytesBefore - impact.bytesAfter)
  const perDay = saved / rangeDays(range)
  return {
    bytes_before: impact.bytesBefore,
    bytes_after: impact.bytesAfter,
    bytes_saved_per_day: Math.round(perDay),
    saved_per_day: formatBytes(perDay),
    percent_of_ingest: snapshot ? pct(saved, snapshot.totals.bytes) : undefined,
    streams_before: impact.streamsBefore,
    streams_after: impact.streamsAfter,
    exact: impact.exact,
    ...(impact.retentionSavedDays !== undefined ? { retention_saved_days: impact.retentionSavedDays } : {}),
    ...(impact.note ? { note: impact.note } : {}),
  }
}

function describeRule(rule: LogRule, snapshot: LogsSnapshot | null) {
  let logql: string | undefined
  try {
    logql = logRuleSelector(rule, snapshot ? { matchers: [{ label: snapshot.groupLabel, op: "=~", value: ".+" }] } : undefined)
  } catch {
    logql = undefined
  }
  return {
    id: rule.id,
    kind: rule.kind,
    description: describeLogRule(rule),
    logql,
    status: rule.status,
    origin: rule.origin,
    rationale: rule.rationale,
    impact: rule.impact && describeImpact(rule.impact, snapshot?.range ?? "24h", snapshot),
  }
}

let logsRefresh: Promise<unknown> | null = null

function groupSelector(snapshot: LogsSnapshot, service: string) {
  return streamSelector([{ label: snapshot.groupLabel, op: "=", value: service }])
}

export const logHandlers: LogHandlers = {
  async get_logs_overview({ limit }) {
    const snapshot = requireLogsSnapshot()
    const perDay = bytesPerDay(snapshot)
    const savings = computeLogSavings(useAppStore.getState().logRules, snapshot)
    return {
      captured_at: snapshot.capturedAt,
      range: snapshot.range,
      streams: snapshot.totals.streams,
      bytes: snapshot.totals.bytes,
      bytes_per_day: Math.round(perDay),
      ingest_per_day: formatBytes(perDay),
      lines: snapshot.totals.lines,
      label_count: snapshot.totals.labelCount,
      group_label: snapshot.groupLabel,
      services: snapshot.groupCount ?? snapshot.groups.length,
      top_services: snapshot.groups.slice(0, limit).map((group) => ({
        [snapshot.groupLabel]: group.value,
        bytes_per_day: Math.round(group.bytes / rangeDays(snapshot.range)),
        percent: group.share,
        streams: group.streams || undefined,
      })),
      top_labels: snapshot.labels.slice(0, limit).map((label) => ({
        label: label.label,
        distinct_values: label.distinctValues,
        ...(label.idLike ? { id_like: true } : {}),
      })),
      active_rules_save: {
        bytes_per_day: Math.round(savings.savedBytes / rangeDays(snapshot.range)),
        percent: Number(savings.percent.toFixed(2)),
        streams: savings.savedStreams,
        estimate: savings.isEstimate,
      },
      note: "Bytes come from Loki's index (index/stats, index/volume) and are estimates of ingested size; 1 KB = 1024 bytes.",
    }
  },

  async refresh_logs_snapshot(_args, { signal }) {
    const connection = requireLogsConnection()
    const { logsSettings, setLogsSnapshot, setLogsSnapshotProgress, log } = useAppStore.getState()
    if (!logsRefresh) {
      log("Agent requested a logs snapshot refresh")
      logsRefresh = fetchLogsSnapshot(connection, {
        range: logsSettings.range,
        groupLabel: logsSettings.groupLabel,
        onProgress: log,
        onStep: setLogsSnapshotProgress,
      })
        .then((snapshot) => {
          setLogsSnapshot(snapshot)
          return snapshot
        })
        .finally(() => {
          setLogsSnapshotProgress(null)
          logsRefresh = null
        })
    }
    const pending = logsRefresh
    const snapshot = (await (signal
      ? Promise.race([pending, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))])
      : pending)) as LogsSnapshot
    return { streams: snapshot.totals.streams, bytes: snapshot.totals.bytes, group_label: snapshot.groupLabel, services: snapshot.groupCount, range: snapshot.range }
  },

  async list_log_services({ by, limit }, { signal }) {
    const connection = requireLogsConnection()
    const snapshot = requireLogsSnapshot()
    const label = by ?? snapshot.groupLabel
    if (label !== snapshot.groupLabel) requireSharing()
    const rows = await fetchIndexVolume(connection, { text: anyValueSelector(label) }, {
      range: timeRangeFor(snapshot.range),
      targetLabels: [label],
      limit: Math.max(limit, 100),
      signal,
    })
    const total = rows.reduce((sum, row) => sum + row.bytes, 0)
    const streams = new Map(snapshot.groups.map((group) => [group.value, group.streams]))
    return {
      by: label,
      range: snapshot.range,
      values_with_volume: rows.length,
      rows: rows.slice(0, limit).map((row) => {
        const value = row.labels[label] ?? ""
        return {
          [label]: value,
          bytes_per_day: Math.round(row.bytes / rangeDays(snapshot.range)),
          percent: pct(row.bytes, total),
          ...(label === snapshot.groupLabel && streams.get(value) ? { streams: streams.get(value) } : {}),
        }
      }),
    }
  },

  async get_log_labels({ service }, { signal }) {
    const snapshot = requireLogsSnapshot()
    if (!service) {
      return {
        scope: "all streams",
        labels: snapshot.labels.map((label) => ({ label: label.label, distinct_values: label.distinctValues, ...(label.idLike ? { id_like: true } : {}) })),
        ...(snapshot.labelsTruncated ? { note: "Some counts hit the cap and are lower bounds." } : {}),
      }
    }
    const connection = requireLogsConnection()
    const range = timeRangeFor(snapshot.range)
    const selector = { text: groupSelector(snapshot, service) }
    const [labels, stats] = await Promise.all([fetchLokiLabels(connection, { range, selector, signal }), fetchIndexStats(connection, selector, { range, signal })])
    const counted = await runWithConcurrency(
      labels.filter((label) => !label.startsWith("__")),
      async (label) => {
        const values = await fetchLokiLabelValues(connection, label, { range, selector, signal })
        return { label, distinct_values: values.length, ...(detectIdLike(values.slice(0, 200)) ? { id_like: true } : {}) }
      },
      4,
      signal
    )
    return {
      scope: `${snapshot.groupLabel}="${service}"`,
      streams: stats.streams,
      bytes_per_day: Math.round(stats.bytes / rangeDays(snapshot.range)),
      labels: counted.sort((a, b) => b.distinct_values - a.distinct_values),
    }
  },

  async get_log_volume({ by, range, limit }, { signal }) {
    const connection = requireLogsConnection()
    const snapshot = useAppStore.getState().logsSnapshot
    if (!snapshot || by !== snapshot.groupLabel) requireSharing()
    const now = Date.now()
    const current = timeRangeFor(range, now)
    const previous = timeRangeFor(range, current.start)
    const query = (window: typeof current) =>
      fetchIndexVolume(connection, { text: anyValueSelector(by) }, { range: window, targetLabels: [by], limit: 1000, signal })
    const [now_, before] = await Promise.all([query(current), query(previous)])
    const prev = new Map(before.map((row) => [row.labels[by] ?? "", row.bytes]))
    const total = now_.reduce((sum, row) => sum + row.bytes, 0)
    const totalBefore = before.reduce((sum, row) => sum + row.bytes, 0)
    const rows = now_.map((row) => {
      const value = row.labels[by] ?? ""
      const was = prev.get(value) ?? 0
      return { value, bytes: row.bytes, delta: row.bytes - was, was }
    })
    const perDay = (bytes: number) => Math.round(bytes / rangeDays(range))
    return {
      by,
      range,
      total_per_day: formatBytes(total / rangeDays(range)),
      change_vs_previous_percent: totalBefore > 0 ? Number((((total - totalBefore) / totalBefore) * 100).toFixed(1)) : null,
      top: rows.slice(0, limit).map((row) => ({ [by]: row.value, bytes_per_day: perDay(row.bytes), percent: pct(row.bytes, total) })),
      top_growers: [...rows]
        .filter((row) => row.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, Math.min(10, limit))
        .map((row) => ({ [by]: row.value, bytes_per_day: perDay(row.bytes), growth_per_day: perDay(row.delta), new: row.was === 0 })),
    }
  },

  async get_log_patterns({ service, limit }, { signal }) {
    requireSharing()
    const connection = requireLogsConnection()
    const snapshot = requireLogsSnapshot()
    const patterns = await fetchPatterns(connection, { text: groupSelector(snapshot, service) }, { range: timeRangeFor(snapshot.range), signal })
    if (patterns === null) return { service, available: false, message: "This Loki doesn't run the pattern ingester (Loki 3.x, pattern_ingester.enabled)." }
    const total = patterns.reduce((sum, pattern) => sum + pattern.count, 0)
    return {
      service,
      available: true,
      range: snapshot.range,
      total_lines: total,
      patterns: patterns.slice(0, limit).map((pattern) => ({
        pattern: pattern.pattern.slice(0, 500),
        level: pattern.level,
        lines: pattern.count,
        percent: pct(pattern.count, total),
      })),
      hint: "A drop_lines or sample rule matches the line with an RE2 regex: use the pattern's literal parts (escaped) joined by .*? in place of <_>.",
    }
  },

  async estimate_log_impact({ rules }, { signal }) {
    const connection = requireLogsConnection()
    const snapshot = requireLogsSnapshot()
    const results = await runWithConcurrency(
      rules,
      async (spec) => {
        try {
          const rule = logSpecToRule(spec, "agent", "proposed")
          signal?.throwIfAborted()
          const impact =
            snapshotLogImpact(rule, snapshot) ?? (await measureLogRuleImpact(connection, rule, { range: snapshot.range, groupLabel: snapshot.groupLabel, signal }))
          if (!impact) return { rule: spec, error: "Too many streams to list for a label estimate; narrow the selector." }
          return { rule: spec, description: describeLogRule(rule), ...describeImpact(impact, snapshot.range, snapshot) }
        } catch (error) {
          return { rule: spec, error: error instanceof Error ? error.message : String(error) }
        }
      },
      2
    )
    signal?.throwIfAborted()
    return {
      range: snapshot.range,
      results,
      note: "Rules on overlapping selectors overlap; don't add their savings. Label rules cut streams, not bytes.",
    }
  },

  async propose_log_rules({ rules: specs, summary }, { signal }) {
    const connection = requireLogsConnection()
    const snapshot = useAppStore.getState().logsSnapshot
    const rules = specs.map((spec) => logSpecToRule({ ...spec, rationale: spec.rationale ?? summary }, "agent", "proposed"))
    if (snapshot) {
      await runWithConcurrency(
        rules,
        async (rule) => {
          if (signal?.aborted) return
          rule.impact =
            snapshotLogImpact(rule, snapshot) ??
            (await measureLogRuleImpact(connection, rule, { range: snapshot.range, groupLabel: snapshot.groupLabel, signal }).catch(() => null)) ??
            undefined
        },
        2
      )
    }
    signal?.throwIfAborted()
    const { addLogRules, log } = useAppStore.getState()
    const { added, skipped } = addLogRules(rules)
    log(`Agent proposed ${added} log rule${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already covered)` : ""}: ${summary}`)
    return {
      proposed: rules.map((rule) => describeRule(rule, snapshot)),
      added,
      skipped_as_duplicates: skipped,
      message: "Proposals are pending on the user's Rules page (Logs) for review.",
    }
  },

  async check_log_usage({ rules: specs }, { signal }) {
    const connection = requireLogsConnection()
    const [rules, index] = await Promise.all([
      fetchLokiRuleQueries(connection, signal).then(
        (list) => ({ list, error: undefined }),
        (error: unknown) => ({ list: null, error: lokiRulesErrorText(error) })
      ),
      readLogqlIndex(),
    ])
    signal?.throwIfAborted()
    const evidence = { rules: rules.list, rulesError: rules.error, dashboards: logqlScanEvidence(index) }
    return specs.map((spec) => {
      const rule = logSpecToRule(spec, "agent", "proposed")
      const summary = summarizeLogRule(rule, evidence)
      if (!summary) return { rule: describeLogRule(rule), used: false, note: "A keep rule removes nothing, so nothing that reads these streams is affected." }
      return {
        rule: describeLogRule(rule),
        used: summary.used,
        found: summary.found,
        may_include: summary.unchecked.filter((line) => line.includes("may include")),
        not_checked: summary.unchecked.filter((line) => !line.includes("may include")),
        checked: summary.checked,
        ...(summary.badge ? { badge: summary.badge } : {}),
      }
    })
  },

  async get_log_rules() {
    const { logRules, logsSnapshot } = useAppStore.getState()
    return logRules.filter((rule) => rule.status !== "rejected").map((rule) => describeRule(rule, logsSnapshot))
  },

  async render_log_config({ format, include_proposed }) {
    const { logRules, logsSnapshot } = useAppStore.getState()
    const selected = logRules
      .filter((rule) => rule.status === "active" || (include_proposed && rule.status === "proposed"))
      .map((rule) => ({ ...rule, status: "active" as const }))
    const options = { range: logsSnapshot?.range }
    const result =
      format === "alloy"
        ? compileAlloyLogs(selected, options)
        : format === "promtail"
          ? compilePromtailLogs(selected, options)
          : format === "loki-limits"
            ? compileLokiLimits(selected, options)
            : compileAdaptiveLogs(selected, options)
    return { config: result.text, warnings: result.warnings }
  },

  async get_log_recommendations({ limit }, { signal }) {
    const connection = requireLogsConnection()
    if (!hasAdaptiveLogs(connection)) {
      throw new Error("Adaptive Logs is only available on a Grafana Cloud Loki connection (https://logs-prod-….grafana.net). Use get_log_patterns instead.")
    }
    requireSharing()
    const rows = recommendationRows(await fetchLogRecommendations(connection, signal))
    return {
      total: rows.length,
      window_days: 15,
      recommendations: rows.slice(0, limit).map((row) => ({
        pattern: row.pattern.slice(0, 500),
        levels: row.recommendation.levels,
        configured_drop_rate: row.recommendation.configured_drop_rate,
        recommended_drop_rate: row.recommendation.recommended_drop_rate,
        locked: row.recommendation.locked || undefined,
        superseded: row.recommendation.superseded || undefined,
        bytes_per_day: Math.round(row.bytesPerDay),
        saves_per_day: Math.round(row.savedBytesPerDay),
        queried_percent: Number((row.queriedShare * 100).toFixed(2)),
      })),
      note: "Recommendations apply in Grafana Cloud's Adaptive Logs app. propose_log_rules can turn one into a sample rule (collector-side) with a regex from the pattern.",
    }
  },
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Logs part of get_session_info. */
export function logsSessionInfo() {
  const { logsSettings, logsSnapshot, logRules } = useAppStore.getState()
  const connection = currentConnection(logsSettings)
  const backend = connection ? hostOf(connection.baseUrl) : null
  return {
    connected: Boolean(connection),
    backend,
    adaptive_logs: connection ? hasAdaptiveLogs(connection) : false,
    snapshot: logsSnapshot
      ? {
          captured_at: logsSnapshot.capturedAt,
          range: logsSnapshot.range,
          streams: logsSnapshot.totals.streams,
          ingest_per_day: formatBytes(bytesPerDay(logsSnapshot)),
          group_label: logsSnapshot.groupLabel,
        }
      : null,
    rules: {
      active: logRules.filter((rule) => rule.status === "active").length,
      proposed: logRules.filter((rule) => rule.status === "proposed").length,
    },
  }
}
