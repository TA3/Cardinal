import { parse } from "yaml"

import { rulesFromRelabel, type ImportResult, type RawRelabelRule } from "@/lib/core/parse/relabel"
import { isLabelName, isMetricName } from "@/lib/core/promql"
import { createRule, mergeRules, ruleKey, type Rule } from "@/lib/core/rules"

type YamlRecord = Record<string, unknown>

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface Found {
  item: unknown
  scrapeJob?: string
}

/**
 * Accepts a bare relabel list, a `metric_relabel_configs:` or
 * `write_relabel_configs:` block, a single scrape config or a full
 * prometheus.yml (scrape and remote_write sections). Rules inside a scrape config carry
 * its `job_name`.
 */
function collectRelabelConfigs(doc: unknown, scrapeJob?: string): Found[] {
  if (Array.isArray(doc)) {
    return doc.flatMap((item) =>
      isRecord(item) && ("source_labels" in item || "action" in item)
        ? [{ item, scrapeJob }]
        : collectRelabelConfigs(item, scrapeJob)
    )
  }
  if (!isRecord(doc)) return []
  const job = doc.job_name === undefined || doc.job_name === null ? scrapeJob : String(doc.job_name)
  const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => ({ item, scrapeJob: job })) : [])
  const nested = (value: unknown) => (Array.isArray(value) ? value.flatMap((config) => collectRelabelConfigs(config, job)) : [])
  // write_relabel_configs (in a remote_write entry) hold the same rules, applied on the way out.
  return [
    ...list(doc.metric_relabel_configs),
    ...list(doc.write_relabel_configs),
    ...nested(doc.scrape_configs),
    ...nested(doc.remote_write),
  ]
}

function toRaw({ item, scrapeJob }: Found): RawRelabelRule {
  const record = isRecord(item) ? item : {}
  const str = (value: unknown) => (value === undefined || value === null ? undefined : String(value))
  return {
    sourceLabels: Array.isArray(record.source_labels) ? record.source_labels.map(String) : [],
    separator: str(record.separator),
    action: str(record.action),
    regex: str(record.regex),
    targetLabel: str(record.target_label),
    replacement: str(record.replacement),
    scrapeJob,
  }
}

const AGGREGATION_EXPR = /^sum without \(([^)]*)\) \(\{__name__=("(?:[^"\\]|\\.)*")(?:,job=("(?:[^"\\]|\\.)*"))?\}\)$/

/** Cardinal's remote-write aggregations (`sum without (…)` recording rules), as aggregate label drops. */
function aggregationRules(doc: unknown): Rule[] {
  if (!isRecord(doc) || !Array.isArray(doc.groups)) return []
  const rules: Rule[] = []
  for (const group of doc.groups) {
    if (!isRecord(group) || !Array.isArray(group.rules)) continue
    for (const item of group.rules) {
      if (!isRecord(item) || typeof item.record !== "string" || typeof item.expr !== "string") continue
      const match = item.expr.trim().match(AGGREGATION_EXPR)
      if (!match) continue
      try {
        const labels = match[1].split(",").map((label) => label.trim())
        const metric = JSON.parse(match[2]) as string
        const job = match[3] === undefined ? undefined : (JSON.parse(match[3]) as string)
        if (!isMetricName(metric) || !labels.length || !labels.every(isLabelName)) continue
        rules.push(
          createRule({ kind: "drop_labels", selector: job === undefined ? { metric } : { metric, job }, labels, onMerge: "aggregate", origin: "import" })
        )
      } catch {
        // Not one of Cardinal's recording rules.
      }
    }
  }
  return rules
}

export function parsePrometheusRelabel(text: string): ImportResult {
  const doc: unknown = parse(text)
  const result = rulesFromRelabel(collectRelabelConfigs(doc).map(toRaw))
  const aggregated = aggregationRules(doc)
  if (!aggregated.length) return result
  // The raw metric's write_relabel drop is part of the aggregation, not a drop of its own.
  const keys = new Set(aggregated.map((rule) => ruleKey({ kind: "drop_metric", selector: rule.selector })))
  const rules = result.rules.filter((rule) => !(rule.kind === "drop_metric" && keys.has(ruleKey(rule))))
  return { ...result, rules: mergeRules(rules, aggregated).rules }
}
