import { buildMarkdownReport } from "@/features/overview/report"
import { describeChain, estimateLabelOwnerSavings, viaText, type Attribution, type AttributedOwner, type OwnerDrilldown } from "@/lib/core/attribution"
import { describeOwnershipRule, ownerRules, ownerSnapshot, type Owner, type OwnerSavings, type RuleOwnership } from "@/lib/core/owner-rules"
import type { Rule } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import type { MetricDrilldown } from "@/lib/prometheus/types"

// Markdown reports per owner and for all owners. A custom-rule owner's report
// is the overview report run on its exact slice of the snapshot; a label
// owner's comes from its drilldown (top metrics and next-label breakdown).

const number = (value: number) => value.toLocaleString("en-US")

function money(series: number, pricePer1k: number) {
  const amount = (series / 1000) * pricePer1k
  const digits = amount < 100 ? 2 : 0
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function cell(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function code(value: string) {
  return `\`${value.replace(/`/g, "'")}\``
}

function chainLine(chain: string[]) {
  const described = describeChain(chain)
  return described ? `Attributed by ${code(described)}, then custom rules.` : "Attributed by custom rules only."
}

export interface RuleOwnerReportInput {
  snapshot: Snapshot
  owned: RuleOwnership
  /** The owner's rules; undefined for Unattributed. */
  owner?: Owner
  chain: string[]
  rules: Rule[]
  drilldowns: Record<string, MetricDrilldown>
  pricePer1k?: number
  source?: string
}

export function buildRuleOwnerMarkdownReport({ snapshot, owned, owner, chain, rules, drilldowns, pricePer1k, source }: RuleOwnerReportInput) {
  const scoped = ownerSnapshot(snapshot, owned)
  const report = buildMarkdownReport({
    snapshot: scoped,
    rules: ownerRules(rules, snapshot, owned),
    drilldowns,
    pricePer1k,
    source: `${owned.unattributed ? "unattributed series" : `owner ${owned.name}`}${source ? ` on ${source}` : ""}`,
  })
  const section: string[] = ["## Attribution", "", chainLine(chain), ""]
  section.push(
    `${owned.unattributed ? "No attribution label or custom rule matches these series" : `${cell(owned.name)} owns these series`}: ${number(owned.series)} (${owned.percent.toFixed(1)}% of all)${
      pricePer1k !== undefined ? `, ≈ ${money(owned.series, pricePer1k)}/mo` : ""
    }.`,
    ""
  )
  if (owner?.rules.length) {
    section.push("Matched by:", "", ...owner.rules.map((rule) => `- ${code(describeOwnershipRule(rule))}`), "")
  } else if (owned.unattributed) {
    section.push("Give them an attribution label, or add a custom rule on Cardinal's Attribution page, so every series has an owner.", "")
  }
  // The overview report opens with a title and a capture line; attribution goes right after them.
  const at = report.indexOf("## Summary")
  return at < 0 ? `${report}\n${section.join("\n")}` : `${report.slice(0, at)}${section.join("\n")}\n${report.slice(at)}`
}

export interface LabelOwnerReportInput {
  snapshot: Snapshot
  owner: AttributedOwner
  chain: string[]
  drilldown: OwnerDrilldown
  rules: Rule[]
  drilldowns: Record<string, MetricDrilldown>
  pricePer1k?: number
  source?: string
}

export function buildLabelOwnerMarkdownReport({ snapshot, owner, chain, drilldown, rules, drilldowns, pricePer1k, source }: LabelOwnerReportInput) {
  const priced = pricePer1k !== undefined
  const lines = [`# ${cell(owner.name)}${source ? `: ${source}` : ""}`, ""]
  if (snapshot.capturedAt) lines.push(`Snapshot ${snapshot.capturedAt}.`, "")
  lines.push("## Attribution", "", chainLine(chain), "")
  lines.push(
    `Series whose ${code(owner.label ?? "")} is ${code(owner.name)}${owner.dimension ? ` (and that lack ${chain.slice(0, owner.dimension).map(code).join(", ")})` : ""}: ${number(owner.series)} (${owner.percent.toFixed(1)}% of all)${
      priced ? `, ≈ ${money(owner.series, pricePer1k)}/mo` : ""
    }.`,
    ""
  )
  lines.push("## Top metrics", "", `| Metric | Series | Share of owner |${priced ? " Cost |" : ""}`, `|---|---:|---:|${priced ? "---:|" : ""}`)
  for (const item of drilldown.metrics) {
    lines.push(
      `| ${code(item.metric)} | ${number(item.series)} | ${owner.series ? ((item.series / owner.series) * 100).toFixed(1) : "0"}% |${priced ? ` ${money(item.series, pricePer1k)}/mo |` : ""}`
    )
  }
  lines.push("", `## By ${cell(drilldown.breakdown.label)}`, "", `| ${cell(drilldown.breakdown.label)} | Series |`, "|---|---:|")
  for (const item of drilldown.breakdown.values) lines.push(`| ${item.value ? cell(item.value) : "_(none)_"} | ${number(item.series)} |`)
  const savings = estimateLabelOwnerSavings(snapshot, drilldown, rules, drilldowns)
  lines.push("", "## Active rules (estimate)", "")
  if (savings.rules.length === 0) lines.push("No active rule touches this owner's top metrics.", "")
  else {
    lines.push(`About ${number(savings.savedSeries)} series saved${priced ? ` (≈ ${money(savings.savedSeries, pricePer1k)}/mo)` : ""}, from each rule's saving scaled by this owner's share of its metric.`, "")
    for (const { rule, savedSeries } of savings.rules) {
      lines.push(`- ${rule.kind} ${code(rule.selector.metric)}${rule.selector.job !== undefined ? ` in job ${code(rule.selector.job)}` : ""}: ~${number(savedSeries)} series`)
    }
    lines.push("")
  }
  lines.push("_Generated by Cardinal. Top metrics are the 20 largest; label-based savings are estimates._", "")
  return lines.join("\n")
}

export interface AttributionSummaryInput {
  snapshot: Snapshot
  attribution: Attribution
  /** Exact savings of custom-rule owners and Unattributed. */
  savings: Map<string, OwnerSavings>
  /** Estimated savings of label owners whose drilldown is loaded. */
  estimates: Map<string, number>
  pricePer1k?: number
  source?: string
}

/** One table of every owner: series, share, cost, active-rule savings and how it was attributed. */
export function buildAttributionSummaryMarkdown({ snapshot, attribution, savings, estimates, pricePer1k, source }: AttributionSummaryInput) {
  const priced = pricePer1k !== undefined
  const lines = [`# Series by owner${source ? `: ${source}` : ""}`, ""]
  lines.push(chainLine(attribution.chain), "")
  lines.push(`${number(attribution.totalSeries)} active series; ${attribution.unattributed.percent.toFixed(1)}% are unattributed.`, "")
  if (snapshot.capturedAt) lines.push(`Snapshot ${snapshot.capturedAt}.`, "")
  lines.push(`| Owner | Via | Series | Share |${priced ? " Cost |" : ""} Rules save |`, `|---|---|---:|---:|${priced ? "---:|" : ""}---:|`)
  for (const owner of [...attribution.owners, attribution.unattributed]) {
    const exact = savings.get(owner.id)
    const estimate = estimates.get(owner.id)
    const saved = exact ? `${exact.isEstimate ? "~" : ""}${number(exact.savedSeries)}` : estimate !== undefined ? `~${number(estimate)}` : "–"
    lines.push(
      `| ${owner.source === "unattributed" ? "_Unattributed_" : cell(owner.name)} | ${viaText(owner)?.replace(/^via /, "") ?? ""} | ${number(owner.series)} | ${owner.percent.toFixed(1)}% |${
        priced ? ` ${money(owner.series, pricePer1k)}/mo |` : ""
      } ${saved} |`
    )
  }
  lines.push("")
  lines.push("_~ marks estimates. Savings for label-attributed owners scale each rule by the owner's share of its metric; – means not loaded._", "")
  if (attribution.approximate) lines.push("_Some counts are approximate: custom label rules overlap, or the snapshot has no per-job counts._", "")
  lines.push("_Generated by Cardinal._", "")
  return lines.join("\n")
}
