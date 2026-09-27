import { computeExpectedSavings, snapshotImpact } from "@/lib/cardinality/dashboard-helpers"
import { csvField } from "@/lib/core/csv"
import { jobLabel } from "@/lib/core/jobs"
import type { Rule } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import type { MetricDrilldown } from "@/lib/prometheus/types"

// A shareable summary of the current snapshot and rules, as Markdown or CSV.

export interface ReportInput {
  snapshot: Snapshot
  rules: Rule[]
  drilldowns: Record<string, MetricDrilldown>
  /** Price per 1,000 series per month; costs are left out when undefined. */
  pricePer1k?: number
  /** The backend's host, for the title. */
  source?: string
  topN?: number
}

const number = (value: number) => value.toLocaleString("en-US")

function money(series: number, pricePer1k: number) {
  const amount = (series / 1000) * pricePer1k
  const digits = amount < 100 ? 2 : 0
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Escapes a Markdown table cell. */
function cell(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function code(value: string) {
  return `\`${value.replace(/`/g, "'")}\``
}

/** Series a rule removes: its measured impact, else the snapshot's exact count for metric drops. */
export function ruleSavedSeries(rule: Rule, snapshot: Snapshot): number | null {
  const impact = rule.impact ?? snapshotImpact(rule, snapshot)
  return impact ? Math.max(0, impact.seriesBefore - impact.seriesAfter) : null
}

function describeRule(rule: Rule) {
  const scope = rule.selector.job === undefined ? "all jobs" : `job ${jobLabel(rule.selector.job)}`
  let what: string
  switch (rule.kind) {
    case "drop_metric":
      what = "Drop metric"
      break
    case "drop_labels":
      what = `Drop label${rule.labels.length === 1 ? "" : "s"} ${rule.labels.map(code).join(", ")}`
      break
    case "drop_series":
      what = `Drop series where ${code(`${rule.match.label}=~"${rule.match.regex}"`)}`
      break
    case "keep_buckets":
      what = `Keep buckets ${rule.buckets.map(code).join(", ")}`
      break
    default:
      what = (rule as { kind: string }).kind
  }
  return { what, metric: code(rule.selector.metric), scope }
}

export function buildMarkdownReport({ snapshot, rules, drilldowns, pricePer1k, source, topN = 20 }: ReportInput) {
  const savings = computeExpectedSavings(rules, snapshot, drilldowns)
  const priced = pricePer1k !== undefined
  const lines: string[] = []
  const captured = new Date(snapshot.capturedAt ?? "")

  lines.push(`# Cardinality report${source ? `: ${source}` : ""}`, "")
  lines.push(`Snapshot taken ${Number.isNaN(captured.getTime()) ? "at an unknown time" : captured.toISOString().replace("T", " ").slice(0, 16) + " UTC"}.`, "")

  lines.push("## Summary", "")
  lines.push(`- **Active series:** ${number(snapshot.totalSeries)}${priced ? ` (≈ ${money(snapshot.totalSeries, pricePer1k)}/mo)` : ""}`)
  lines.push(`- **Metrics:** ${number(snapshot.metricCount)}`)
  lines.push(`- **Jobs:** ${number(snapshot.jobs.length)}`)
  if (snapshot.labelCount !== null) lines.push(`- **Label names:** ${number(snapshot.labelCount)}`)
  lines.push(
    `- **Active rules save:** ${savings.isEstimate ? "~" : ""}${number(savings.savedSeries)} series (${savings.percent.toFixed(1)}%)${
      priced ? `, ≈ ${money(savings.savedSeries, pricePer1k)}/mo` : ""
    }`
  )
  lines.push("")

  lines.push(`## Top ${Math.min(topN, snapshot.metrics.length)} metrics`, "")
  lines.push("| # | Metric | Series | Share | Top job |", "|---:|---|---:|---:|---|")
  snapshot.metrics.slice(0, topN).forEach((metric, index) => {
    const job = metric.topJob === undefined ? "" : cell(jobLabel(metric.topJob))
    lines.push(`| ${index + 1} | ${code(metric.metric)} | ${number(metric.seriesCount)} | ${metric.percentageOfTotal.toFixed(1)}% | ${job} |`)
  })
  lines.push("")

  lines.push(`## Top ${Math.min(topN, snapshot.jobs.length)} jobs`, "")
  lines.push("| # | Job | Series | Share | Metrics |", "|---:|---|---:|---:|---:|")
  snapshot.jobs.slice(0, topN).forEach((job, index) => {
    lines.push(`| ${index + 1} | ${cell(jobLabel(job.job))} | ${number(job.seriesCount)} | ${job.percentageOfTotal.toFixed(1)}% | ${number(job.metricCount)} |`)
  })
  lines.push("")

  const active = rules.filter((rule) => rule.status === "active")
  const proposed = rules.filter((rule) => rule.status === "proposed")
  lines.push("## Rules", "")
  if (!active.length && !proposed.length) {
    lines.push("No rules yet.", "")
  }
  for (const [title, list] of [
    ["Active", active],
    ["Proposed", proposed],
  ] as const) {
    if (!list.length) continue
    lines.push(`### ${title}`, "")
    lines.push(`| Rule | Metric | Scope | Series saved |${priced ? " Cost saved |" : ""}`, `|---|---|---|---:|${priced ? "---:|" : ""}`)
    for (const rule of list) {
      const { what, metric, scope } = describeRule(rule)
      const saved = ruleSavedSeries(rule, snapshot)
      const savedText = saved === null ? "not measured" : number(saved)
      const costText = priced ? (saved === null ? " |" : ` ≈ ${money(saved, pricePer1k)}/mo |`) : ""
      lines.push(`| ${what} | ${metric} | ${cell(scope)} | ${savedText} |${costText}`)
    }
    lines.push("")
  }
  if (savings.isEstimate) lines.push("_Totals marked ~ include label drops that are not measured yet._", "")
  lines.push("_Generated by Cardinal._", "")
  return lines.join("\n")
}

/** Every metric in the snapshot: series, share and top job. */
export function buildMetricsCsv(snapshot: Snapshot) {
  const rows = [["metric", "series", "share_percent", "top_job"].join(",")]
  for (const metric of snapshot.metrics) {
    rows.push(
      [metric.metric, metric.seriesCount, metric.percentageOfTotal.toFixed(2), metric.topJob === undefined ? "" : jobLabel(metric.topJob)]
        .map(csvField)
        .join(",")
    )
  }
  return `${rows.join("\n")}\n`
}
