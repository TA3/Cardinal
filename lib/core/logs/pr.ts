// "Copy PR description" for log rules: a Markdown summary with a rules table,
// the measured savings (bytes per day, streams) and each rule's rationale.
// The logs twin of prDescription in lib/core/report.ts.

import { formatBytes } from "@/lib/core/bytes"
import type { LogSavings } from "@/lib/core/logs/impact"
import { describeLogRule } from "@/lib/core/logs/rules"
import type { LogRule } from "@/lib/core/logs/types"

export interface LogPrContext {
  generatedAt: Date
  target: string
  /** Length of the snapshot range in days; impacts are per range and shown per day. */
  rangeDays: number
  /** Bytes per day in the snapshot, for the share. */
  totalBytesPerDay: number
  totalStreams: number
  savings: LogSavings
  /** Cost of a byte count per day; null without a price. */
  cost?: (bytes: number) => number | null
  formatCost?: (amount: number) => string
  /** Usage evidence per rule id: a short note, null for none found. Missing = not checked. */
  usage?: Record<string, string | null>
  /** Active keep rules the exported stages leave alone. */
  keeps?: LogRule[]
}

const md = (text: string) => text.replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\s+/g, " ").trim()

function perDay(bytes: number, rangeDays: number) {
  return bytes / Math.max(rangeDays, 1 / 24)
}

function ruleCells(rule: LogRule, context: LogPrContext) {
  const impact = rule.impact
  if (!impact) return { bytes: "not measured", streams: "–", saved: null as number | null }
  const saved = perDay(Math.max(0, impact.bytesBefore - impact.bytesAfter), context.rangeDays)
  const streams =
    impact.streamsBefore !== undefined && impact.streamsAfter !== undefined ? Math.max(0, impact.streamsBefore - impact.streamsAfter) : 0
  const approx = impact.exact ? "" : "~"
  return {
    bytes: saved > 0 ? `${approx}${formatBytes(saved)}/day` : rule.kind === "retention" ? "storage only" : "0",
    streams: streams > 0 ? `${approx}−${streams.toLocaleString("en-US")}` : "–",
    saved,
  }
}

export function logPrDescription(rules: LogRule[], context: LogPrContext) {
  const priced = context.cost?.(1) != null
  const header = ["Rule", "Ingest saved", "Streams", ...(priced ? ["Cost / day"] : []), "Usage evidence"]
  const rows = rules.map((rule) => {
    const cells = ruleCells(rule, context)
    const cost = cells.saved === null ? null : context.cost?.(cells.saved)
    const usage = context.usage?.[rule.id]
    return [
      md(describeLogRule(rule)),
      cells.bytes,
      cells.streams,
      ...(priced ? [cost != null && context.formatCost ? context.formatCost(cost) : "–"] : []),
      md(usage === undefined ? "not checked" : (usage ?? "none found")),
    ]
  })
  const table = [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, index) => (index >= 1 && index < header.length - 1 ? "---:" : "---")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ]
  const { savings } = context
  const savedPerDay = perDay(savings.savedBytes, context.rangeDays)
  const approx = savings.isEstimate ? "about " : ""
  const totals = [
    `${approx}${formatBytes(savedPerDay)} of ingest per day (${savings.percent.toFixed(1)}% of ${formatBytes(context.totalBytesPerDay)}/day)`,
    savings.savedStreams > 0 ? `${savings.savedStreams.toLocaleString("en-US")} streams (${savings.streamsPercent.toFixed(1)}%)` : "",
  ].filter(Boolean)
  const cost = context.cost?.(savedPerDay)
  const rationale = rules.filter((rule) => rule.rationale).map((rule) => `- **${md(describeLogRule(rule))}**: ${md(rule.rationale ?? "")}`)
  const keeps = (context.keeps ?? []).map((rule) => `- **${md(describeLogRule(rule))}**: ${md(rule.rationale ?? "")}`)
  return [
    "## Reduce log volume and stream cardinality",
    "",
    `${rules.length} ${context.target} rule${rules.length === 1 ? "" : "s"} generated with Cardinal on ${context.generatedAt.toISOString().slice(0, 10)}. Expected to remove ${totals.join(" and ")}${cost != null && context.formatCost ? `, ≈ ${context.formatCost(cost)}/day` : ""}.`,
    "",
    ...table,
    "",
    "### Rationale",
    "",
    ...(rationale.length ? rationale : ["_No rationale recorded for these rules._"]),
    "",
    ...(keeps.length ? ["### Kept on purpose", "", "The rules above leave these lines alone:", "", ...keeps, ""] : []),
    "Bytes come from Loki's index (index/stats, index/volume) and bytes_over_time over the snapshot range; level and sampling savings are estimates, and kept lines are taken out of the savings. Label moves and drops shrink streams, not ingested bytes. Usage evidence covers Loki alerting and recording rules, plus Grafana dashboards when a LogQL scan exists.",
    "",
  ].join("\n")
}
