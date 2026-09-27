import { parse } from "yaml"

import { rulesFromRelabel, type ImportResult, type RawRelabelRule } from "@/lib/core/parse/relabel"

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

export function parsePrometheusRelabel(text: string): ImportResult {
  const doc: unknown = parse(text)
  return rulesFromRelabel(collectRelabelConfigs(doc).map(toRaw))
}
