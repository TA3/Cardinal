// Grafana Cloud Adaptive Logs drop rules. The payload shape (segment_id, name,
// version, disabled, body.stream_selector / drop_rate / levels /
// log_line_contains) and POST /adaptive-logs/drop-rules are documented at
// https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/manage-as-code/adaptive-logs-api/
// Adaptive Logs only drops (a share of) lines; label changes and retention have no equivalent.

import {
  commentText,
  compilableRules,
  type LogCompileOptions,
  type LogCompileResult,
} from "@/lib/core/logs/compile/common"
import { exemptionProblem, type AdaptiveLogsExemption } from "@/lib/core/logs/adaptive-apply"
import { describeLogRule } from "@/lib/core/logs/rules"
import { renderSelector, selectorsDisjoint } from "@/lib/core/logs/selector"
import type { KeepRule, LineFilter, LogRule } from "@/lib/core/logs/types"
import { parseLiteralAlternation } from "@/lib/core/regex"

/** Tenant-wide segment. */
export const GLOBAL_SEGMENT = "__global__"

export interface AdaptiveLogsDropRuleBody {
  stream_selector: string
  /** Percentage of matching lines to drop, 0–100. */
  drop_rate: number
  levels?: string[]
  log_line_contains?: string[]
}

export interface AdaptiveLogsDropRule {
  id?: string
  segment_id: string
  name: string
  version: number
  disabled: boolean
  expires_at?: string
  created_at?: string
  updated_at?: string
  body: AdaptiveLogsDropRuleBody
}

export interface AdaptiveLogsCompileResult extends LogCompileResult {
  /** Payloads for POST /adaptive-logs/drop-rules, one per rule. */
  dropRules: AdaptiveLogsDropRule[]
  /** Payloads for POST /adaptive-logs/exemptions, one per keep rule. */
  exemptions: AdaptiveLogsExemption[]
}

/**
 * The exemption for a keep rule. Exemptions select whole streams, so a keep of
 * some lines exempts all of its streams (it protects more, never less).
 */
export function keepExemption(rule: KeepRule): { exemption: AdaptiveLogsExemption; warning?: string } | { problem: string } {
  if (rule.selector.matchers.length === 0) return { problem: "Adaptive Logs exemptions need a stream selector" }
  const exemption: AdaptiveLogsExemption = {
    stream_selector: renderSelector(rule.selector),
    ...(rule.rationale ? { reason: commentText(rule.rationale, 500) } : {}),
  }
  const problem = exemptionProblem(exemption)
  if (problem) return { problem }
  return rule.line
    ? { exemption, warning: `"${commentText(describeLogRule(rule), 120)}" becomes an exemption for every line of ${exemption.stream_selector}: exemptions select streams, not lines.` }
    : { exemption }
}

const SUPPORTED = ["drop_streams", "drop_lines", "sample"] as const

/** A line regex that is one plain literal (`healthcheck`, `GET /ready`), else null: log_line_contains is a substring match. */
function literalSubstring(regex: string) {
  const names = parseLiteralAlternation(regex)
  if (!names || names.length !== 1 || !names[0]) return null
  // parseLiteralAlternation strips ^ and $; an anchored regex is not a substring match.
  if (/^\^|(^|[^\\])\$$/.test(regex)) return null
  return names[0]
}

function lineFields(line: LineFilter | undefined): Pick<AdaptiveLogsDropRuleBody, "levels" | "log_line_contains"> | null {
  if (!line) return {}
  if (line.levels?.length) return { levels: line.levels }
  const literal = literalSubstring(line.regex ?? "")
  return literal === null ? null : { log_line_contains: [literal] }
}

const round = (value: number) => Math.round(value * 100) / 100

/** Drop rules for the rules Adaptive Logs can express; the rest are skipped with a warning. */
export function compileAdaptiveLogs(rules: LogRule[], options: LogCompileOptions & { segmentId?: string } = {}): AdaptiveLogsCompileResult {
  const { rules: selected, keeps, warnings } = compilableRules(rules, SUPPORTED, "Adaptive Logs", options)
  const dropRules: AdaptiveLogsDropRule[] = []
  const exemptions: AdaptiveLogsExemption[] = []
  for (const keep of keeps) {
    const result = keepExemption(keep)
    if ("problem" in result) {
      warnings.push(`Skipped "${commentText(describeLogRule(keep), 120)}": ${result.problem}.`)
      continue
    }
    if (result.warning) warnings.push(result.warning)
    if (!exemptions.some((item) => item.stream_selector === result.exemption.stream_selector)) exemptions.push(result.exemption)
  }
  for (const rule of selected) {
    const overlapping = keeps.filter((keep) => !selectorsDisjoint(keep.selector, rule.selector))
    if (overlapping.length) {
      warnings.push(
        `"${commentText(describeLogRule(rule), 120)}" overlaps keep rule${overlapping.length === 1 ? "" : "s"} ${overlapping.map((keep) => `"${commentText(describeLogRule(keep), 80)}"`).join(", ")}: an Adaptive Logs drop rule can't leave lines out, so narrow its selector if those lines must stay.`
      )
    }
    if (rule.selector.matchers.length === 0) {
      warnings.push(`Skipped "${commentText(describeLogRule(rule), 120)}": Adaptive Logs drop rules need a stream selector.`)
      continue
    }
    const line = rule.kind === "drop_lines" || rule.kind === "sample" ? rule.line : undefined
    const fields = lineFields(line)
    if (!fields) {
      warnings.push(
        `Skipped "${commentText(describeLogRule(rule), 120)}": Adaptive Logs matches lines by level or plain substrings, not regexes.`
      )
      continue
    }
    dropRules.push({
      segment_id: options.segmentId ?? GLOBAL_SEGMENT,
      name: commentText(describeLogRule(rule), 200),
      version: 1,
      disabled: false,
      body: {
        stream_selector: renderSelector(rule.selector),
        drop_rate: rule.kind === "sample" ? round((1 - rule.keep) * 100) : 100,
        ...fields,
      },
    })
  }
  const text = dropRules.length || exemptions.length ? `${JSON.stringify(exemptions.length ? { drop_rules: dropRules, exemptions } : dropRules, null, 2)}\n` : "[]\n"
  return { text, warnings, dropRules, exemptions }
}

/**
 * Step-by-step text for doing the same in the Grafana Cloud UI (Adaptive Logs →
 * Drop rules), for users without an adaptive-logs:admin token.
 */
export function adaptiveLogsInstructions(result: Pick<AdaptiveLogsCompileResult, "dropRules" | "exemptions">) {
  if (result.dropRules.length === 0 && result.exemptions.length === 0) return "No rules can be expressed as Adaptive Logs drop rules.\n"
  const lines = [
    "In Grafana Cloud, open Adaptive Logs → Drop rules and create one rule per entry:",
    "",
    ...result.dropRules.flatMap((rule, index) => [
      `${index + 1}. ${rule.name}`,
      `   Stream selector: ${rule.body.stream_selector}`,
      `   Drop rate: ${rule.body.drop_rate}%`,
      ...(rule.body.levels ? [`   Levels: ${rule.body.levels.join(", ")}`] : []),
      ...(rule.body.log_line_contains ? [`   Log line contains: ${rule.body.log_line_contains.join(", ")}`] : []),
      "",
    ]),
    ...(result.exemptions.length
      ? [
          "Then open Adaptive Logs → Exemptions and add one per keep rule:",
          ...result.exemptions.map((item, index) => `${index + 1}. ${item.stream_selector}${item.reason ? ` (${item.reason})` : ""}`),
          "",
        ]
      : []),
    "Or POST each entry to <loki-url>/adaptive-logs/drop-rules (and /adaptive-logs/exemptions) with basic auth <instance-id>:<token> (scope adaptive-logs:admin).",
  ]
  return `${lines.join("\n")}\n`
}
