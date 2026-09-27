import { z } from "zod"

import { CHURN_WINDOWS } from "@/lib/core/churn"
import { JOB_VALUE, LABEL_NAME, MAX_NAME_LENGTH, METRIC_NAME } from "@/lib/core/promql"
import { LOKI_LABEL_NAME } from "@/lib/core/logql"

// MCP tools exposed to agents. The Worker registers these with the MCP server
// and relays each call to the user's Cardinal tab, which executes it with the
// same code the UI uses. Keep outputs compact: they land in an agent's context.

const metricName = z.string().max(MAX_NAME_LENGTH).regex(METRIC_NAME, "invalid metric name")
const labelName = z.string().max(MAX_NAME_LENGTH).regex(LABEL_NAME, "invalid label name")
// "" selects series without a job label. Job names reach exported configs, so
// control characters (newlines could end a config comment) are rejected.
const jobName = z.string().max(MAX_NAME_LENGTH).regex(JOB_VALUE, "job must not contain control characters")
const attributionInput = z.object({
  top_owners: z.number().int().min(1).max(50).default(15).describe("Owners to list, largest first; the rest are counted."),
  top_metrics: z.number().int().min(1).max(20).default(10),
})

export const ruleSpec = z.object({
  kind: z
    .enum(["drop_metric", "drop_labels", "drop_series", "keep_buckets"])
    .describe(
      "drop_metric drops every series; drop_labels removes labels (may merge series, then it needs Adaptive Metrics); drop_series drops series whose label matches a regex (relabel-safe); keep_buckets keeps only the listed le buckets of a _bucket metric (relabel-safe)."
    ),
  metric: metricName,
  job: jobName
    .optional()
    .describe('Scope the rule to one job ("" = series without a job label). Omit to apply to every job.'),
  labels: z.array(labelName).min(1).optional().describe("Required for drop_labels."),
  match: z
    .object({ label: labelName, regex: z.string().min(1).max(500).describe("Fully anchored RE2, as in relabel config.") })
    .optional()
    .describe("Required for drop_series."),
  buckets: z
    .array(z.string().max(40))
    .min(1)
    .max(60)
    .optional()
    .describe('Required for keep_buckets: le values to keep, e.g. ["0.1","0.5","1"]. "+Inf" is always kept.'),
  rationale: z.string().max(1000).optional(),
})
export type RuleSpec = z.infer<typeof ruleSpec>

// ---- logs (Loki) ----

const lokiLabel = z.string().max(200).regex(LOKI_LABEL_NAME, "invalid label name")
// Values reach LogQL (escaped) and exported configs, so control characters are refused.
// eslint-disable-next-line no-control-regex
const noControl = /^[^\u0000-\u001f\u007f]*$/
const logsRange = z.enum(["1h", "24h", "7d"])
const logMatcher = z
  .object({
    label: lokiLabel,
    op: z.enum(["=", "!=", "=~", "!~"]),
    value: z.string().max(1024).regex(noControl, "value must not contain control characters").describe("Exact value, or an RE2 regex for =~ / !~ (fully anchored)."),
  })
  .strict()
const logLevel = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/, "invalid level")

export const logRuleSpec = z
  .object({
    kind: z
      .enum(["drop_streams", "drop_lines", "sample", "drop_label", "label_to_metadata", "retention", "keep"])
      .describe(
        "drop_streams drops whole streams; drop_lines drops lines matching `line`; sample keeps a share (`keep`) of lines (optionally only those matching `line`); drop_label removes a label (streams merge, safe in Loki); label_to_metadata moves a high-cardinality label to structured metadata (Loki 3+, still queryable; the usual fix); retention keeps matching streams `days` days (storage only); keep protects lines (all of the selector's, or those matching `line`) from the other drop and sample rules and becomes an Adaptive Logs exemption; it needs a rationale."
      ),
    selector: z
      .array(logMatcher)
      .max(32)
      .describe('Stream selector as matchers, e.g. [{"label":"service_name","op":"=","value":"api"}]. [] means all streams (only for drop_lines, sample, drop_label, label_to_metadata, and keep with a line filter).'),
    line: z
      .object({
        regex: z.string().min(1).max(1000).regex(noControl).optional().describe("RE2 matched against the line (unanchored)."),
        levels: z.array(logLevel).min(1).max(16).optional().describe('Log levels, e.g. ["debug","trace"].'),
      })
      .strict()
      .refine((line) => (line.regex === undefined) !== (line.levels === undefined), "set exactly one of regex or levels")
      .optional()
      .describe("Required for drop_lines; optional for sample and keep."),
    keep: z.number().gt(0).lt(1).optional().describe("Required for sample: share of matching lines to keep, e.g. 0.1."),
    label: lokiLabel.optional().describe("Required for drop_label and label_to_metadata."),
    days: z.number().int().min(1).max(3650).optional().describe("Required for retention."),
    rationale: z.string().max(500).optional().describe("Why; required for keep."),
  })
  .strict()
export type LogRuleSpec = z.infer<typeof logRuleSpec>

const serviceValue = z.string().min(1).max(1024).regex(noControl, "value must not contain control characters")

export const logToolDefinitions = {
  get_logs_overview: {
    title: "Logs overview",
    description:
      "From the logs (Loki) snapshot: streams, ingest bytes and bytes per day over the snapshot range, label count, the group label (usually service_name), the top services by bytes with streams and share, and the labels with the most distinct values (ID-like ones flagged). Call get_session_info first; it says whether logs are connected.",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
  },
  refresh_logs_snapshot: {
    title: "Refresh logs snapshot",
    description:
      "Re-measures streams and bytes per service and distinct values per label from Loki's index (about 2 + services + labels requests). Only call it when get_session_info reports no logs snapshot or a stale one.",
    input: z.object({}),
    readOnly: true,
  },
  list_log_services: {
    title: "List log services",
    description:
      "Bytes and share per value of a label over the snapshot range, largest first (index/volume). `by` defaults to the snapshot's group label (service_name); streams are included for the group label. Values of other labels count as label values: refused when the user disabled sharing them.",
    input: z.object({ by: lokiLabel.optional(), limit: z.number().int().min(1).max(200).default(30) }),
    readOnly: true,
  },
  get_log_labels: {
    title: "Log labels",
    description:
      "Stream labels with their distinct-value counts (ID-like ones flagged: request ids, pod hashes, paths) for all streams, or for one service. High-cardinality labels multiply streams; the fix is usually label_to_metadata. Returns names and counts only, never values.",
    input: z.object({ service: serviceValue.optional().describe("A value of the group label, e.g. a service_name.") }),
    readOnly: true,
  },
  get_log_volume: {
    title: "Log volume",
    description:
      "Ingested bytes by a label's values over 1h, 24h or 7d, with the change against the previous period of the same length (top growers). Values of labels other than the group label are label values: refused when the user disabled sharing them.",
    input: z.object({ by: lokiLabel, range: logsRange.default("24h"), limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
  },
  get_log_patterns: {
    title: "Log patterns",
    description:
      "Line patterns of one service from Loki's pattern ingester (Loki 3.x): pattern text, level, line count and share, most frequent first. Patterns are line content, so this is refused when the user disabled sharing label values. Use them for drop_lines / sample rules with a regex built from the pattern's literal parts.",
    input: z.object({ service: serviceValue, limit: z.number().int().min(1).max(50).default(20) }),
    readOnly: true,
  },
  estimate_log_impact: {
    title: "Estimate log rule impact",
    description:
      "Bytes and streams before/after for candidate log rules over the snapshot range, measured with index/stats, bytes_over_time and the series API. Level and sample rules are estimates; label rules change streams, not bytes; retention changes storage only.",
    input: z.object({ rules: z.array(logRuleSpec).min(1).max(30) }),
    readOnly: true,
  },
  propose_log_rules: {
    title: "Propose log rules",
    description:
      "Adds log rules to the user's Cardinal draft as pending proposals (Rules page, Logs). The user reviews and accepts or rejects each; nothing is applied to any system. Impact is measured automatically.",
    input: z.object({
      rules: z.array(logRuleSpec).min(1).max(30),
      summary: z.string().max(2000).describe("Why these rules, in a few sentences, shown to the user."),
    }),
    readOnly: false,
  },
  check_log_usage: {
    title: "Check log usage",
    description:
      "Where candidate log rules' streams are read, the same evidence the user's rule toggles show: Loki alerting and recording rules (the ruler API) and LogQL panels from the user's Grafana dashboard scan. Per rule: whether something reads it, what (found), queries that select by other labels and may include these streams, and what couldn't be checked. Call it before proposing drops, samples or label changes, and say so when something reads them. Keep rules remove nothing and get no evidence.",
    input: z.object({ rules: z.array(logRuleSpec).min(1).max(30) }),
    readOnly: true,
  },
  get_log_rules: {
    title: "Current log rules",
    description: "Log rules in the user's Cardinal draft: active ones and pending proposals, with measured impacts.",
    input: z.object({}),
    readOnly: true,
  },
  render_log_config: {
    title: "Render log config",
    description:
      "Renders accepted log rules (optionally including proposals) as a Grafana Alloy loki.process block, Promtail pipeline_stages, Loki limits (retention_stream) or Grafana Cloud Adaptive Logs drop rules JSON, with warnings for rules a format can't express.",
    input: z.object({
      format: z.enum(["alloy", "promtail", "loki-limits", "adaptive-logs"]),
      include_proposed: z.boolean().default(false),
    }),
    readOnly: true,
  },
  get_log_recommendations: {
    title: "Adaptive Logs recommendations",
    description:
      "Grafana Cloud Adaptive Logs recommendations: per line pattern, the configured and recommended drop rates, ingest per day, bytes per day the recommendation would save, and how much of it queries read. Only for Grafana Cloud Loki connections (logs-prod-….grafana.net). Pattern text counts as sharing values.",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
  },
} as const

export const toolDefinitions = {
  get_session_info: {
    title: "Session info",
    description:
      "Backend type, available capabilities (e.g. Grafana Cloud Adaptive Metrics), snapshot age and rule counts, plus `signals`: which of metrics (Prometheus) and logs (Loki) are connected, with each one's snapshot and rules. Call this first.",
    input: z.object({}),
    readOnly: true,
  },
  refresh_snapshot: {
    title: "Refresh snapshot",
    description:
      "Re-counts active series per job and metric. Expensive on large instances; only call when get_session_info reports no snapshot or a stale one.",
    input: z.object({}),
    readOnly: true,
  },
  get_overview: {
    title: "Cardinality overview",
    description: "Total active series plus the top metrics and jobs by series count, with share of total.",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
  },
  list_metrics: {
    title: "List metrics",
    description: "Metrics sorted by series count, filterable by job, name prefix/substring and minimum series.",
    input: z.object({
      job: jobName.optional(),
      contains: z.string().optional(),
      min_series: z.number().int().min(0).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    readOnly: true,
  },
  get_metric_breakdown: {
    title: "Metric breakdown",
    description:
      "For one metric: series count, distinct values per label (highest first) and series per job. Use to find which labels drive cardinality.",
    input: z.object({ metric: metricName, job: jobName.optional() }),
    readOnly: true,
  },
  get_label_values: {
    title: "Top label values",
    description: "The label's values with the most series for a metric. Useful to judge whether a label is unbounded (IDs, URLs, timestamps).",
    input: z.object({
      metric: metricName,
      label: labelName,
      job: jobName.optional(),
      limit: z.number().int().min(1).max(200).default(25),
    }),
    readOnly: true,
  },
  check_usage: {
    title: "Check metric usage",
    description:
      "Where metrics are used: Prometheus alerting/recording rules and, on Grafana Cloud, dashboard/query/rule usage counts from Adaptive Metrics. Never propose dropping a metric that is used without saying so.",
    input: z.object({ metrics: z.array(metricName).min(1).max(100) }),
    readOnly: true,
  },
  check_dashboard_usage: {
    title: "Check dashboard usage",
    description:
      "Grafana dashboards, panels, template variables and Grafana-managed alerts that read a metric (from the user's last Grafana scan, any Grafana, not only Cloud), with links. For each label given, says whether a query filters, groups, joins or displays by it (used), only aggregates it away (safe), or plots the metric unaggregated so the label shows as separate lines. Call before proposing drop_labels.",
    input: z.object({
      metric: metricName,
      labels: z.array(labelName).max(50).optional().describe("Labels you consider dropping from the metric."),
    }),
    readOnly: true,
  },
  estimate_impact: {
    title: "Estimate impact",
    description:
      "Exact series before/after for candidate rules, measured with PromQL. For drop_labels, `merges_series: true` means the labels distinguish series: a relabel rule would create duplicate samples, so it must be applied as an Adaptive Metrics aggregation.",
    input: z.object({ rules: z.array(ruleSpec).min(1).max(50) }),
    readOnly: true,
  },
  get_adaptive_recommendations: {
    title: "Adaptive Metrics recommendations",
    description:
      "Grafana Cloud Adaptive Metrics recommendations (usage-aware aggregations), largest savings first. Only available for Grafana Cloud connections.",
    input: z.object({
      action: z.enum(["add", "update", "remove", "keep"]).optional(),
      limit: z.number().int().min(1).max(200).default(30),
    }),
    readOnly: true,
  },
  get_attribution: {
    title: "Attribution by owner",
    description:
      "Who owns the series: each series belongs to the value of the user's Primary attribution label (e.g. team), else the Secondary, then the Third; series with none fall to custom owner rules, then Unattributed. Returns each owner's series, share, monthly cost, how it was attributed (`via`), what the active rules save it (estimates for label owners), and top metrics for the largest owners. Use it to say which owner should cut what. Returns a `disabled` message when the user has attribution turned off.",
    input: attributionInput,
    readOnly: true,
  },
  get_teams: {
    title: "Teams (deprecated)",
    description: "Deprecated alias of get_attribution; call get_attribution instead.",
    input: attributionInput,
    readOnly: true,
  },
  get_rules: {
    title: "Current rules",
    description: "Rules in the user's Cardinal draft: active ones and pending agent proposals.",
    input: z.object({}),
    readOnly: true,
  },
  propose_rules: {
    title: "Propose rules",
    description:
      "Adds rules to the user's Cardinal draft as pending proposals. The user reviews and accepts or rejects each one; nothing is applied to any system. Impact is measured automatically.",
    input: z.object({
      rules: z.array(ruleSpec).min(1).max(50),
      summary: z.string().max(2000).describe("Why these rules, in a few sentences, shown to the user."),
    }),
    readOnly: false,
  },
  get_histograms: {
    title: "Histogram buckets",
    description:
      "Classic histogram families (_bucket/_sum/_count) by bucket series: le count, label sets, a suggested reduced le set (from the observed bucket distribution and quantiles used in rules) with its precision cost, and estimated savings for bucket reduction and for migrating to native histograms. Also lists metrics already stored as native histograms. All savings are estimates.",
    input: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
    readOnly: true,
  },
  render_config: {
    title: "Render config",
    description: "Renders accepted rules (optionally including proposals) as Prometheus YAML, Alloy, or Adaptive Metrics JSON.",
    input: z.object({
      format: z.enum(["prometheus", "alloy", "adaptive-metrics"]),
      include_proposed: z.boolean().default(false),
      mode: z.enum(["combined", "split-by-job"]).default("combined"),
    }),
    readOnly: true,
  },
  get_churn: {
    title: "Series churn",
    description:
      "Series that appeared and disappeared within a window (seen via last_over_time minus active now), per job and metric, most churned first, plus the global series-creation rate when the backend exposes it. Pass `metric` (and optionally `job`) to also get its label drivers: labels whose distinct values over the window exceed their values now (pod, container id, request id…). Grafana Cloud and Mimir bill on series seen over time, so churn costs money that an instant count hides.",
    input: z.object({
      window: z.enum(CHURN_WINDOWS).default("1h"),
      job: jobName.optional().describe('Only this job ("" = series without a job label).'),
      metric: metricName.optional().describe("Also return label drivers for this metric."),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    readOnly: true,
  },
  ...logToolDefinitions,
} as const

export type ToolName = keyof typeof toolDefinitions
export type ToolArgs<T extends ToolName> = z.infer<(typeof toolDefinitions)[T]["input"]>

export const toolNames = Object.keys(toolDefinitions) as ToolName[]

export function isToolName(value: string): value is ToolName {
  return value in toolDefinitions
}
