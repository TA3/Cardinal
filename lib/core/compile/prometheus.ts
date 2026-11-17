import { Document, isScalar, isSeq, visit } from "yaml"

import { KEEP_BUCKET_MARK, KEEP_METRIC_MARK, KEEP_VALUE_MARK, type Aggregation, type RelabelPlan, type RelabelSection, type RelabelStep } from "@/lib/core/compile/plan"
import { assertLabelName, selector } from "@/lib/core/promql"
import { escapeJoinedPart, joinSeparator, literalAlternation } from "@/lib/core/regex"
import { ALWAYS_KEPT } from "@/lib/core/rules"
import { GROUP_RELABEL_MARK, groupedExpr, groupingRecordName } from "@/lib/core/value-groups"

export interface RelabelConfig {
  source_labels?: string[]
  separator?: string
  regex: string
  action: "drop" | "replace" | "labeldrop"
  target_label?: string
  replacement?: string
}

/**
 * source_labels, separator and regex for a condition over joined labels:
 * `[job,] __name__, ...labels` against `[job;] metric;...parts`. Only the last
 * part may be a pattern; it is wrapped in a group so it can't reach the others.
 */
export function joinedCondition(job: string | undefined, metric: string, labels: string[], parts: string[]) {
  const separator = joinSeparator(job)
  const head = job === undefined ? [] : [escapeJoinedPart(job, separator)]
  return {
    source_labels: [...(job === undefined ? [] : ["job"]), "__name__", ...labels],
    ...(separator === ";" ? {} : { separator }),
    regex: [...head, escapeJoinedPart(metric, separator), ...parts].join(separator),
  }
}

/** A relabel replacement is expanded (`$1`); `$$` keeps a literal dollar. */
const literalReplacement = (value: string) => value.replace(/\$/g, "$$$$")

export function toRelabelConfigs(step: RelabelStep): RelabelConfig[] {
  if (step.kind === "keep_metrics") {
    // RE2 can't say "this job and not these names": mark the kept series of
    // the job, drop the job's unmarked ones, remove the mark.
    const separator = joinSeparator(step.job)
    const job = escapeJoinedPart(step.job, separator)
    const names = [literalAlternation(step.metrics), ALWAYS_KEPT].filter(Boolean).join("|")
    const sep = separator === ";" ? {} : { separator }
    return [
      { source_labels: ["job", "__name__"], ...sep, regex: `${job}${separator}(${names})`, action: "replace", target_label: KEEP_METRIC_MARK, replacement: "1" },
      { source_labels: ["job", KEEP_METRIC_MARK], ...sep, regex: `${job}${separator}`, action: "drop" },
      { regex: KEEP_METRIC_MARK, action: "labeldrop" },
    ]
  }
  if (step.kind === "group_values") {
    // The group name goes to a temporary label first so every group matches
    // the original value: the rest is written first, then groups from last
    // to first, so the first matching group is written last and wins.
    const mark = (part: string, name: string): RelabelConfig => ({
      ...joinedCondition(step.job, step.metric, [step.label], [part]),
      action: "replace",
      target_label: GROUP_RELABEL_MARK,
      replacement: literalReplacement(name),
    })
    return [
      ...(step.rest ? [mark(".+", step.rest)] : []),
      ...[...step.groups].reverse().map((group) => mark(`(${group.regex})`, group.name)),
      {
        ...joinedCondition(step.job, step.metric, [GROUP_RELABEL_MARK], ["(.+)"]),
        action: "replace",
        target_label: step.label,
        replacement: "$1",
      },
      { regex: GROUP_RELABEL_MARK, action: "labeldrop" },
    ]
  }
  if (step.kind === "drop_series") {
    return [{ ...joinedCondition(step.job, step.metric, [step.label], [`(${step.regex})`]), action: "drop" }]
  }
  if (step.kind === "keep_buckets") {
    return [
      {
        ...joinedCondition(step.job, step.metric, ["le"], [`(${literalAlternation(step.buckets)})`]),
        action: "replace",
        target_label: KEEP_BUCKET_MARK,
        replacement: "1",
      },
      // A bucket (non-empty le) without the mark is one to drop.
      { ...joinedCondition(step.job, step.metric, ["le", KEEP_BUCKET_MARK], [".+", ""]), action: "drop" },
      { regex: KEEP_BUCKET_MARK, action: "labeldrop" },
    ]
  }
  if (step.kind === "keep_value") {
    return [
      {
        ...joinedCondition(step.job, step.metric, [step.label], [`(${literalAlternation([step.value])})`]),
        action: "replace",
        target_label: KEEP_VALUE_MARK,
        replacement: "1",
      },
      // The label set to another value, and not marked: drop.
      { ...joinedCondition(step.job, step.metric, [step.label, KEEP_VALUE_MARK], [".+", ""]), action: "drop" },
      { regex: KEEP_VALUE_MARK, action: "labeldrop" },
    ]
  }
  return [toRelabelConfig(step)]
}

function toRelabelConfig(step: Exclude<RelabelStep, { kind: "drop_series" | "keep_buckets" | "keep_value" | "group_values" | "keep_metrics" }>): RelabelConfig {
  if (step.kind === "drop") {
    const names = literalAlternation(step.metrics)
    if (step.job === undefined) return { source_labels: ["__name__"], regex: names, action: "drop" }
    const separator = joinSeparator(step.job)
    return {
      source_labels: ["job", "__name__"],
      ...(separator === ";" ? {} : { separator }),
      regex: `${escapeJoinedPart(step.job, separator)}${separator}(${names})`,
      action: "drop",
    }
  }

  // Clearing a label (replacement "") removes it from the series. Scoped to the
  // metric (and job) because `labeldrop` cannot be scoped.
  const metric = escapeJoinedPart(step.metric)
  if (step.job === undefined) {
    return {
      source_labels: ["__name__", step.label],
      regex: `${metric};.+`,
      action: "replace",
      target_label: step.label,
      replacement: "",
    }
  }
  const separator = joinSeparator(step.job)
  return {
    source_labels: ["job", "__name__", step.label],
    ...(separator === ";" ? {} : { separator }),
    regex: `${escapeJoinedPart(step.job, separator)}${separator}${metric}${separator}.+`,
    action: "replace",
    target_label: step.label,
    replacement: "",
  }
}

function renderYaml(value: unknown) {
  const doc = new Document(value)
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === "source_labels" && isSeq(pair.value)) {
        pair.value.flow = true
      }
    },
  })
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

const configs = (sections: RelabelSection[]) => sections.flatMap((section) => section.steps.flatMap(toRelabelConfigs))

/**
 * Where the rules run: `scrape` (metric_relabel_configs, before local storage)
 * or `remote_write` (write_relabel_configs: full data stays local, only what is
 * shipped remotely is cut).
 */
export type PrometheusStage = "scrape" | "remote_write"

/** The series a remote-write aggregation records: `<metric>:sum_without_<labels>`. */
export function aggregationRecordName(aggregation: Pick<Aggregation, "metric" | "labels" | "grouping">) {
  if (aggregation.grouping) return groupingRecordName(aggregation.metric, aggregation.grouping)
  return `${aggregation.metric}:sum_without_${aggregation.labels.map(assertLabelName).join("_")}`
}

/** A recording rule summing the metric without the dropped labels. */
export function aggregationRule(aggregation: Aggregation) {
  const sel = selector({ metric: aggregation.metric, matchers: aggregation.job === undefined ? undefined : { job: aggregation.job } })
  if (aggregation.grouping) return { record: aggregationRecordName(aggregation), expr: groupedExpr(sel, aggregation.grouping) }
  return { record: aggregationRecordName(aggregation), expr: `sum without (${aggregation.labels.map(assertLabelName).join(", ")}) (${sel})` }
}

export const AGGREGATION_GROUP = "cardinal-aggregations"

function renderRemoteWrite(plan: RelabelPlan) {
  const sections = plan.sections.filter((section) => section.steps.length > 0)
  if (sections.length === 0) return "write_relabel_configs: []\n"
  // Every step already carries its job condition, so one list serves all jobs.
  const relabel = `# Add write_relabel_configs to the remote_write entry that ships to your remote backend.\n${renderYaml({
    remote_write: [{ url: "https://<your-remote-write-endpoint>/api/v1/push", write_relabel_configs: configs(sections) }],
  })}`
  if (plan.aggregations.length === 0) return relabel
  const groups = renderYaml({ groups: [{ name: AGGREGATION_GROUP, rules: plan.aggregations.map(aggregationRule) }] })
  return `${relabel}\n# Recording rules: add to a rule file (rule_files) so the sums are shipped instead of the dropped raw series.\n${groups}`
}

/**
 * Combined output is a single `metric_relabel_configs` list. Split output is
 * one YAML document: rules not tied to a scrape job (or for series without a
 * job) under `metric_relabel_configs`, the rest under `scrape_configs` by
 * `job_name`, which the importer reads back as the rule's job.
 */
export function renderPrometheus(plan: RelabelPlan, stage: PrometheusStage = "scrape") {
  if (stage === "remote_write") return renderRemoteWrite(plan)
  const sections = plan.sections.filter((section) => section.steps.length > 0)
  if (sections.length === 0) return "metric_relabel_configs: []\n"
  if (sections.length === 1 && sections[0].job === undefined) {
    return renderYaml({ metric_relabel_configs: configs(sections) })
  }

  const global = sections.filter((section) => !section.job)
  const perJob = sections.filter((section) => section.job)
  const parts: string[] = []
  if (global.length > 0) {
    parts.push(
      `# Not tied to a scrape job: add to every scrape config.\n${renderYaml({ metric_relabel_configs: configs(global) })}`
    )
  }
  if (perJob.length > 0) {
    const scrapeConfigs = perJob.map((section) => ({
      job_name: section.job,
      metric_relabel_configs: configs([section]),
    }))
    parts.push(
      `# Merge each job's metric_relabel_configs into the scrape config with that job_name.\n${renderYaml({ scrape_configs: scrapeConfigs })}`
    )
  }
  return parts.join("\n")
}
