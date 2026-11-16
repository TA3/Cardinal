import type { CollectorGrouping } from "@/lib/core/compile/plan"
import { histogramFamily } from "@/lib/core/families"
import { assertLabelName } from "@/lib/core/promql"
import { escapeJoinedPart } from "@/lib/core/regex"
import { GROUP_TEMP_LABEL, type GroupAggregation } from "@/lib/core/value-groups"

// Value groupings in Grafana Alloy, without recording rules. Series of the
// grouped metrics are split off after Cardinal's relabel rules and sent
// through OpenTelemetry: `otelcol.processor.transform` folds the label values
// into their groups and `aggregate_on_attribute_value` combines the series
// that merge, per target, before anything reaches remote_write. Everything
// else goes straight on as before.

export const GROUPING_LABEL = "cardinal_grouping"
const PLAIN_LABEL = "cardinal_ungrouped"

/** A Go-style string literal for OTTL: backslashes and quotes escaped. */
function ottlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** An Alloy string holding OTTL: a raw string reads best, unless it contains a backtick. */
function alloyRaw(value: string) {
  return value.includes("`") ? JSON.stringify(value) : `\`${value}\``
}

const OTTL_AGGREGATION: Record<GroupAggregation, string> = { sum: "sum", count: "count", max: "max", min: "min", avg: "mean" }

/**
 * Names the metric may carry inside OpenTelemetry: as scraped, without
 * `_total` (when the receiver normalises counter names), and the histogram or
 * summary family name its `_bucket`/`_sum`/`_count` series belong to.
 */
function otelNames(metric: string) {
  const names = new Set([metric])
  if (metric.endsWith("_total")) names.add(metric.slice(0, -"_total".length))
  const family = histogramFamily(metric)
  if (family.part) names.add(family.base)
  return Array.from(names)
}

/** The metric (and job) condition for one grouping. The receiver maps `job` to service.namespace/service.name. */
function condition(item: CollectorGrouping) {
  const names = otelNames(item.metric).map((name) => `metric.name == ${ottlString(name)}`)
  const parts = [names.length === 1 ? names[0] : `(${names.join(" or ")})`]
  if (item.job !== undefined) {
    const slash = item.job.indexOf("/")
    if (slash === -1) parts.push(`resource.attributes["service.name"] == ${ottlString(item.job)}`)
    else {
      parts.push(`resource.attributes["service.namespace"] == ${ottlString(item.job.slice(0, slash))}`)
      parts.push(`resource.attributes["service.name"] == ${ottlString(item.job.slice(slash + 1))}`)
    }
  }
  return parts.join(" and ")
}

/** OTTL statements: datapoint-level value folding, then metric-level merging. */
export function groupingStatements(groupings: CollectorGrouping[]) {
  const datapoint: string[] = []
  const metric: string[] = []
  const temp = `attributes[${ottlString(GROUP_TEMP_LABEL)}]`
  for (const item of groupings) {
    const { grouping } = item
    const label = `attributes[${ottlString(assertLabelName(grouping.label))}]`
    const where = condition(item)
    // The group name goes to a temporary attribute first, so every group
    // matches the original value and the first matching group wins.
    for (const group of grouping.groups) {
      datapoint.push(
        `set(${temp}, ${ottlString(group.name)}) where ${where} and ${temp} == nil and ${label} != nil and IsMatch(${label}, ${ottlString(`^(?:${group.regex})$`)})`
      )
    }
    if (grouping.rest) {
      datapoint.push(`set(${temp}, ${ottlString(grouping.rest)}) where ${where} and ${temp} == nil and ${label} != nil and ${label} != ""`)
    }
    datapoint.push(`set(${label}, ${temp}) where ${where} and ${temp} != nil`)
    datapoint.push(`delete_key(attributes, ${ottlString(GROUP_TEMP_LABEL)}) where ${where}`)

    // Histograms (and their parts) only combine by sum.
    const aggregation = histogramFamily(item.metric).part ? "sum" : OTTL_AGGREGATION[grouping.aggregation]
    const names = Array.from(new Set([...grouping.groups.map((group) => group.name), ...(grouping.rest ? [grouping.rest] : [])]))
    for (const name of names) {
      metric.push(`aggregate_on_attribute_value(${ottlString(aggregation)}, ${ottlString(grouping.label)}, [${ottlString(name)}], ${ottlString(name)}) where ${where}`)
    }
  }
  return { datapoint, metric }
}

/** `__name__;job` condition matching the grouped series, for the split. */
function splitRegex(groupings: CollectorGrouping[]) {
  const parts = groupings.map((item) => `${escapeJoinedPart(item.metric)};${item.job === undefined ? ".*" : escapeJoinedPart(item.job)}`)
  return Array.from(new Set(parts)).join("|")
}

/** The receiver Cardinal's relabel components forward to when there are groupings. */
export const GROUPING_FORWARD = [`prometheus.relabel.${PLAIN_LABEL}.receiver`, `prometheus.relabel.${GROUPING_LABEL}.receiver`]

/** The Alloy components: the split, the OTel round trip with the transform, and back to remote_write. */
export function renderGroupings(groupings: CollectorGrouping[]) {
  if (!groupings.length) return ""
  const regex = JSON.stringify(splitRegex(groupings))
  const { datapoint, metric } = groupingStatements(groupings)
  const list = (statements: string[]) => statements.map((statement) => `      ${alloyRaw(statement)},`).join("\n")
  return [
    "// Value groupings: the grouped metrics leave the Prometheus pipeline here,",
    "// get their label values folded and merged series combined in OpenTelemetry,",
    "// and come back to remote_write. Everything else goes straight on.",
    `prometheus.relabel ${JSON.stringify(PLAIN_LABEL)} {`,
    "  forward_to = [prometheus.remote_write.default.receiver]",
    "",
    "  rule {",
    `    source_labels = ["__name__", "job"]`,
    `    regex         = ${regex}`,
    `    action        = "drop"`,
    "  }",
    "}",
    "",
    `prometheus.relabel ${JSON.stringify(GROUPING_LABEL)} {`,
    `  forward_to = [otelcol.receiver.prometheus.${GROUPING_LABEL}.receiver]`,
    "",
    "  rule {",
    `    source_labels = ["__name__", "job"]`,
    `    regex         = ${regex}`,
    `    action        = "keep"`,
    "  }",
    "}",
    "",
    `otelcol.receiver.prometheus ${JSON.stringify(GROUPING_LABEL)} {`,
    "  output {",
    `    metrics = [otelcol.processor.transform.${GROUPING_LABEL}.input]`,
    "  }",
    "}",
    "",
    "// Needs Alloy v1.8 or later (aggregate_on_attribute_value with context-qualified paths).",
    `otelcol.processor.transform ${JSON.stringify(GROUPING_LABEL)} {`,
    `  error_mode = "ignore"`,
    "",
    "  metric_statements {",
    `    context    = "datapoint"`,
    "    statements = [",
    list(datapoint),
    "    ]",
    "  }",
    "",
    "  metric_statements {",
    `    context    = "metric"`,
    "    statements = [",
    list(metric),
    "    ]",
    "  }",
    "",
    "  output {",
    `    metrics = [otelcol.exporter.prometheus.${GROUPING_LABEL}.input]`,
    "  }",
    "}",
    "",
    "// Back to Prometheus series with the same names and labels (no target_info, no scope labels).",
    `otelcol.exporter.prometheus ${JSON.stringify(GROUPING_LABEL)} {`,
    "  add_metric_suffixes  = false",
    "  include_target_info  = false",
    "  include_scope_labels = false",
    "  forward_to           = [prometheus.remote_write.default.receiver]",
    "}",
  ].join("\n")
}
