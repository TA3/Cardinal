// Reads Loki `retention_stream` entries (limits_config or runtime overrides)
// back into retention rules.

import { parse } from "yaml"

import type { LogImportResult } from "@/lib/core/logs/parse/stages"
import { createLogRule, mergeLogRules } from "@/lib/core/logs/rules"
import { parseLogSelector } from "@/lib/core/logs/selector"
import type { LogRule } from "@/lib/core/logs/types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const UNIT_HOURS: Record<string, number> = { ms: 1 / 3_600_000, s: 1 / 3600, m: 1 / 60, h: 1, d: 24, w: 168, y: 8760 }

/** Hours in a Prometheus-style duration like "168h", "7d" or "1w2d"; null when it doesn't parse. */
export function durationHours(text: string): number | null {
  const trimmed = text.trim()
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(trimmed)) return null
  let hours = 0
  for (const [, amount, unit] of trimmed.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) hours += Number(amount) * UNIT_HOURS[unit]
  return hours
}

function collectEntries(doc: unknown): unknown[] {
  if (Array.isArray(doc)) {
    return doc.some((item) => isRecord(item) && "selector" in item && "period" in item) ? doc : doc.flatMap(collectEntries)
  }
  if (!isRecord(doc)) return []
  return Object.entries(doc).flatMap(([key, value]) => (key === "retention_stream" && Array.isArray(value) ? value : collectEntries(value)))
}

export function parseLokiLimits(text: string): LogImportResult {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    return { rules: [], warnings: [`Not valid YAML: ${error instanceof Error ? error.message : String(error)}`], ruleCount: 0 }
  }
  const entries = collectEntries(doc)
  const warnings: string[] = entries.length ? [] : ["No retention_stream entries found."]
  const rules: LogRule[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const selectorText = String(entry.selector ?? "")
    const hours = durationHours(String(entry.period ?? ""))
    if (hours === null || hours < 24) {
      warnings.push(`Ignored retention for ${selectorText}: period ${JSON.stringify(entry.period)} is not a duration of at least 24h.`)
      continue
    }
    const days = Math.round(hours / 24)
    if (days * 24 !== hours) warnings.push(`Rounded retention for ${selectorText} from ${entry.period} to ${days} days.`)
    try {
      const parsed = parseLogSelector(selectorText)
      if (parsed.filters.length || parsed.rest) throw new Error("retention selectors take label matchers only")
      rules.push(createLogRule({ kind: "retention", selector: parsed.selector, days, origin: "import" }))
    } catch (error) {
      warnings.push(`Ignored retention for ${selectorText}: ${error instanceof Error ? error.message : String(error)}.`)
    }
  }
  return { rules: mergeLogRules([], rules).rules, warnings, ruleCount: entries.length }
}
