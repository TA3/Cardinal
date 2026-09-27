// Loki `limits_config.retention_stream` export for retention rules. Format per
// https://grafana.com/docs/loki/latest/operations/storage/retention/ : label
// matchers only, period at least 24h, the highest priority wins on overlap.

import { Document } from "yaml"

import {
  commentText,
  compilableRules,
  headerLines,
  ruleCommentLines,
  type LogCompileOptions,
  type LogCompileResult,
} from "@/lib/core/logs/compile/common"
import { renderSelector } from "@/lib/core/logs/selector"
import type { LogRule, RetentionRule } from "@/lib/core/logs/types"

export interface RetentionStream {
  selector: string
  priority: number
  period: string
}

export interface LokiLimitsOptions extends LogCompileOptions {
  /** Render a per-tenant runtime override (`overrides: {<tenant>: …}`) instead of limits_config. */
  tenant?: string
}

/**
 * Entries with priorities: a selector with more matchers is more specific and
 * gets a higher priority, so it wins over a broader one it overlaps.
 */
export function retentionStreams(rules: RetentionRule[]): RetentionStream[] {
  return rules.map((rule) => ({
    selector: renderSelector(rule.selector),
    priority: rule.selector.matchers.length,
    period: `${rule.days * 24}h`,
  }))
}

export function compileLokiLimits(rules: LogRule[], options: LokiLimitsOptions = {}): LogCompileResult {
  const { rules: selected, warnings } = compilableRules(rules, ["retention"], "Loki limits", options)
  const retention = selected.filter((rule): rule is RetentionRule => rule.kind === "retention")
  if (retention.length === 0) return { text: "# No retention rules to export\n", warnings }

  const entries = retentionStreams(retention)
  const body = options.tenant !== undefined
    ? { overrides: { [options.tenant]: { retention_stream: entries } } }
    : { limits_config: { retention_stream: entries } }
  const doc = new Document(body)
  const yaml = doc.toString({ lineWidth: 0 })

  const notes = [
    ...headerLines(retention, options, "Loki").map((line) => `# ${line}`),
    ...retention.flatMap((rule, index) => ruleCommentLines(rule, options).map((line) => `#   ${index + 1}. ${line}`)),
    "# Retention needs the compactor with retention_enabled: true.",
    options.tenant !== undefined
      ? `# Per-tenant override for ${commentText(JSON.stringify(options.tenant), 80)}: it replaces the global retention_stream list for that tenant, so copy any global entries you still want.`
      : "# Global limits apply to every tenant without an override. For one tenant, put retention_stream under overrides.<tenant> in the runtime config instead (it replaces the global list for that tenant).",
    "# Streams matching no entry keep retention_period. On overlap the highest priority wins, then the shortest period.",
  ]
  return { text: `${notes.join("\n")}\n${yaml}`, warnings }
}
