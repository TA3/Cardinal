// Reads Promtail `pipeline_stages` back into log rules. Accepts a bare stage
// list, a `pipeline_stages:` block, a scrape config or a whole promtail.yml.

import { parse } from "yaml"

import type { Stage } from "@/lib/core/logs/compile/stages"
import { rulesFromStages, type LogImportResult } from "@/lib/core/logs/parse/stages"

type YamlRecord = Record<string, unknown>

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const str = (value: unknown) => (value === undefined || value === null ? undefined : String(value))
const DROP_KEYS = new Set(["source", "expression", "value", "drop_counter_reason", "separator"])
const STAGE_NAMES = new Set(["match", "drop", "sampling", "labeldrop", "structured_metadata", "regex", "json", "logfmt", "labels", "docker", "cri"])

function toStage(item: unknown): Stage {
  if (!isRecord(item)) return { type: "other", name: "a stage that is not a map" }
  const [name] = Object.keys(item)
  const config = item[name]
  const record = isRecord(config) ? config : {}
  switch (name) {
    case "match":
      return {
        type: "match",
        selector: str(record.selector) ?? "",
        ...(str(record.action) === "drop" ? { action: "drop" as const } : {}),
        reason: str(record.drop_counter_reason),
        stages: Array.isArray(record.stages) ? record.stages.map(toStage) : [],
      }
    case "drop": {
      const extra = Object.keys(record).filter((key) => !DROP_KEYS.has(key))
      if (extra.length || Array.isArray(record.source)) return { type: "other", name: `drop with ${extra.join(", ") || "a source list"}` }
      return {
        type: "drop",
        source: str(record.source),
        expression: str(record.expression),
        value: str(record.value),
        reason: str(record.drop_counter_reason),
      }
    }
    case "regex":
      return record.source ? { type: "other", name: "regex on a source" } : { type: "regex", expression: str(record.expression) ?? "" }
    case "sampling": {
      const rate = Number(record.rate)
      return Number.isFinite(rate) && record.rate !== undefined ? { type: "sampling", rate } : { type: "other", name: "sampling without a rate" }
    }
    case "labeldrop":
      return { type: "label_drop", labels: Array.isArray(config) ? config.map(String) : [] }
    case "structured_metadata": {
      const entries = Object.entries(record)
      if (entries.some(([key, value]) => value !== null && value !== undefined && value !== "" && value !== key)) {
        return { type: "other", name: "structured_metadata with renamed fields" }
      }
      return { type: "structured_metadata", labels: entries.map(([key]) => key) }
    }
    default:
      return { type: "other", name: name ?? "an empty stage" }
  }
}

function looksLikeStages(list: unknown[]) {
  return list.some((item) => isRecord(item) && Object.keys(item).some((key) => STAGE_NAMES.has(key)))
}

function collectStages(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return looksLikeStages(doc) ? doc : doc.flatMap(collectStages)
  if (!isRecord(doc)) return []
  if (Array.isArray(doc.pipeline_stages)) return doc.pipeline_stages
  return [...collectStages(doc.scrape_configs), ...(isRecord(doc.match) ? [doc] : [])]
}

export function promtailStages(text: string): Stage[] {
  return collectStages(parse(text)).map(toStage)
}

export function parsePromtailLogs(text: string): LogImportResult {
  let stages: Stage[]
  try {
    stages = promtailStages(text)
  } catch (error) {
    return { rules: [], warnings: [`Not valid YAML: ${error instanceof Error ? error.message : String(error)}`], ruleCount: 0 }
  }
  return rulesFromStages(stages, stages.length ? [] : ["No pipeline_stages found."], text)
}
