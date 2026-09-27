import {
  OWNER_COLORS,
  UNATTRIBUTED_ID,
  UNATTRIBUTED_NAME,
  assignOwnershipCells,
  describeOwnershipRule,
  isValidColor,
  newOwnerId,
  ruleOwnerSavings,
  withoutLabels,
  type JobOwner,
  type LabelRuleRows,
  type Owner,
  type OwnershipRule,
  type RuleOwnership,
} from "@/lib/core/owner-rules"
import { assertLabelName, isLabelName, quoteLabelValue } from "@/lib/core/promql"
import type { Rule } from "@/lib/core/rules"
import { computeExpectedSavings } from "@/lib/core/savings"
import { toPercent, type Snapshot } from "@/lib/core/snapshot"
import type { JobMetricSeries, MetricDrilldown } from "@/lib/prometheus/types"

// Attribution: who owns each series. A series belongs to the value of its
// Primary attribution label; without it, the Secondary label, then the Third.
// Series with none of them fall through to the custom owner rules
// (lib/core/owner-rules.ts), and whatever those miss is Unattributed.

export const ATTRIBUTION_LEVELS = ["Primary", "Secondary", "Third"] as const

/** Label names teams commonly attribute by, offered first in Settings. */
export const SUGGESTED_ATTRIBUTION_LABELS = ["team", "owner", "namespace", "service", "app", "squad", "cost_center"]

export interface AttributionSettings {
  /** Off by default: no nav tab, no job badges, the agent tool refuses. */
  enabled: boolean
  /** Primary, Secondary and Third label names; "" = not set. */
  labels: string[]
  /** Custom owner rules for series without any attribution label, checked in order. */
  owners: Owner[]
}

export const DEFAULT_ATTRIBUTION: AttributionSettings = { enabled: false, labels: ["", "", ""], owners: [] }

export const ATTRIBUTION_DISABLED_MESSAGE = "attribution is disabled in Cardinal settings"

/** Why a label can't be an attribution label; null when it can ("" = unset is fine). */
export function attributionLabelProblem(label: string): string | null {
  if (label === "") return null
  if (!isLabelName(label)) return "Not a valid label name: letters, digits and _ only, not starting with a digit"
  if (label === "__name__") return "The metric name can't attribute series"
  if (label.startsWith("__")) return "Labels starting with __ are reserved"
  return null
}

/** The labels to resolve, in order: valid, set and without repeats (at most three). */
export function attributionChain(labels: readonly string[]): string[] {
  const chain: string[] = []
  for (const label of labels.slice(0, ATTRIBUTION_LEVELS.length)) {
    if (label && !attributionLabelProblem(label) && !chain.includes(label)) chain.push(label)
  }
  return chain
}

/** "team → namespace → service", or null without labels. */
export function describeChain(chain: string[]) {
  return chain.length ? chain.join(" → ") : null
}

function readOwner(value: unknown, index: number): Owner | null {
  const raw = (value ?? {}) as Record<string, unknown>
  if (typeof raw.name !== "string" || !Array.isArray(raw.rules)) return null
  const rules = raw.rules.filter((rule): rule is OwnershipRule => {
    const item = (rule ?? {}) as Record<string, unknown>
    return (item.kind === "job" || item.kind === "metric_prefix" || item.kind === "label") && typeof item.pattern === "string"
  })
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newOwnerId(),
    name: raw.name,
    color: isValidColor(raw.color) ? raw.color : OWNER_COLORS[index % OWNER_COLORS.length],
    rules,
  }
}

/** Settings read from storage, repaired where needed. */
export function normalizeAttribution(value: unknown): AttributionSettings {
  const raw = (value ?? {}) as Partial<Record<keyof AttributionSettings, unknown>>
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 3).map((label) => (typeof label === "string" ? label : "")) : []
  while (labels.length < 3) labels.push("")
  const owners = Array.isArray(raw.owners) ? raw.owners.flatMap((owner, index) => readOwner(owner, index) ?? []) : []
  return { enabled: raw.enabled === true, labels, owners }
}

/**
 * Store migration from the Teams feature: its teams become custom owner rules
 * with no attribution labels (so they own exactly what they did), enabled
 * when there were any.
 */
export function migrateTeamsToAttribution(persisted: { teams?: unknown; attribution?: unknown }): AttributionSettings {
  if (persisted.attribution) return normalizeAttribution(persisted.attribution)
  const owners = normalizeAttribution({ owners: persisted.teams }).owners
  return { ...DEFAULT_ATTRIBUTION, enabled: owners.length > 0, owners }
}

// Queries. Label names are validated, values escaped.

function by(labels: string[]) {
  return labels.map(assertLabelName).join(", ")
}

function jobMatcher(job: string | undefined) {
  return job === undefined ? "" : `,job=${quoteLabelValue(job)}`
}

/** Selector for the series an owner value was resolved from: earlier chain labels empty, its own label equal. */
export function ownerSelector(chain: string[], dimension: number, value: string) {
  const label = chain[dimension]
  if (label === undefined) throw new Error(`No attribution label at level ${dimension + 1}`)
  return `{__name__=~".+"${withoutLabels(chain.slice(0, dimension))},${assertLabelName(label)}=${quoteLabelValue(value)}}`
}

/** The label an owner's drilldown breaks down by: the next attribution label, else job. */
export function breakdownLabel(chain: string[], dimension: number) {
  return chain[dimension + 1] ?? "job"
}

const DRILL_LIMIT = 20

export const attributionQueries = {
  /** Series per combination of the attribution labels; `job` narrows it for large tenants. */
  seriesByChain: (chain: string[], job?: string) => `count by (${by(chain)}) ({__name__=~".+"${jobMatcher(job)}})`,
  /** Job×metric counts of series without any attribution label, for the custom rules. */
  unlabelledByJobMetric: (chain: string[], job?: string) =>
    `count by (job, __name__) ({__name__=~".+"${withoutLabels(chain)}${jobMatcher(job)}})`,
  /** Series per job and attribution labels, for the owner badges on jobs. */
  seriesByJobAndChain: (chain: string[]) => `count by (${by(["job", ...chain])}) ({__name__=~".+"})`,
  ownerTopMetrics: (chain: string[], dimension: number, value: string) =>
    `topk(${DRILL_LIMIT}, count by (__name__) (${ownerSelector(chain, dimension, value)}))`,
  ownerBreakdown: (chain: string[], dimension: number, value: string) =>
    `topk(${DRILL_LIMIT}, count by (${by([breakdownLabel(chain, dimension)])}) (${ownerSelector(chain, dimension, value)}))`,
}

// Resolution.

export interface ChainRow {
  labels: Record<string, string>
  seriesCount: number
}

export interface LabelOwner {
  id: string
  value: string
  /** Index of the attribution label it came from (0 = Primary). */
  dimension: number
  series: number
}

export function labelOwnerId(dimension: number, value: string) {
  return `label:${dimension}:${value}`
}

/** The fallback chain over `count by (chain)` rows: each row goes to its first set label, or to `unlabelled`. */
export function resolveChain(rows: ChainRow[], chain: string[]) {
  const owners = new Map<string, LabelOwner>()
  let unlabelled = 0
  for (const row of rows) {
    const dimension = chain.findIndex((label) => (row.labels[label] ?? "") !== "")
    if (dimension < 0) {
      unlabelled += row.seriesCount
      continue
    }
    const value = row.labels[chain[dimension]]
    const id = labelOwnerId(dimension, value)
    const owner = owners.get(id) ?? { id, value, dimension, series: 0 }
    owner.series += row.seriesCount
    owners.set(id, owner)
  }
  const list = Array.from(owners.values()).sort((a, b) => b.series - a.series || a.dimension - b.dimension || a.value.localeCompare(b.value))
  return { owners: list, unlabelled, labelled: list.reduce((sum, owner) => sum + owner.series, 0) }
}

function hash(text: string) {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (Math.imul(value, 31) + text.charCodeAt(index)) | 0
  return Math.abs(value)
}

/** A stable colour per owner value. */
export function labelOwnerColor(value: string) {
  return OWNER_COLORS[hash(value) % OWNER_COLORS.length]
}

export type AttributionSource = "label" | "rule" | "unattributed"

export interface AttributedOwner {
  id: string
  name: string
  color?: string
  source: AttributionSource
  /** Label owners: the chain index and label name that attributed them. */
  dimension?: number
  label?: string
  series: number
  /** Share of all series, 0 to 100. */
  percent: number
  /** Rule owners and Unattributed: exact job×metric cells. */
  ownership?: RuleOwnership
}

export interface Attribution {
  chain: string[]
  totalSeries: number
  /** Label owners (largest first), then custom rule owners in rule order. */
  owners: AttributedOwner[]
  unattributed: AttributedOwner
  /** Series attributed by each chain label, then by custom rules. */
  seriesByLabel: number[]
  seriesByRules: number
  /** Keys of custom label rules whose rows are not loaded yet. */
  pendingLabelRules: string[]
  approximate: boolean
}

export interface AttributionInput {
  chain: string[]
  /** `count by (chain)` rows; ignored without a chain. */
  chainRows?: ChainRow[]
  /** Job×metric cells of the series without any attribution label (the whole snapshot without a chain). */
  unlabelled: { cells: JobMetricSeries[]; exact: boolean }
  owners: Owner[]
  labelRows?: LabelRuleRows
}

export function buildAttribution({ chain, chainRows = [], unlabelled, owners, labelRows = {} }: AttributionInput): Attribution {
  const resolved = chain.length ? resolveChain(chainRows, chain) : { owners: [], labelled: 0, unlabelled: 0 }
  const cellsTotal = unlabelled.cells.reduce((sum, cell) => sum + cell.seriesCount, 0)
  const totalSeries = resolved.labelled + cellsTotal
  const ruled = assignOwnershipCells(unlabelled.cells, owners, labelRows, { exact: unlabelled.exact, totalSeries })
  const seriesByLabel = chain.map(() => 0)
  const labelOwners = resolved.owners.map((owner): AttributedOwner => {
    seriesByLabel[owner.dimension] += owner.series
    return {
      id: owner.id,
      name: owner.value,
      color: labelOwnerColor(owner.value),
      source: "label",
      dimension: owner.dimension,
      label: chain[owner.dimension],
      series: owner.series,
      percent: toPercent(owner.series, totalSeries),
    }
  })
  const fromRules = ruled.owners.map(
    (owned): AttributedOwner => ({ id: owned.id, name: owned.name, color: owned.color, source: "rule", series: owned.series, percent: owned.percent, ownership: owned })
  )
  return {
    chain,
    totalSeries,
    owners: [...labelOwners, ...fromRules],
    unattributed: {
      id: UNATTRIBUTED_ID,
      name: UNATTRIBUTED_NAME,
      source: "unattributed",
      series: ruled.unattributed.series,
      percent: ruled.unattributed.percent,
      ownership: ruled.unattributed,
    },
    seriesByLabel,
    seriesByRules: fromRules.reduce((sum, owner) => sum + owner.series, 0),
    pendingLabelRules: ruled.pendingLabelRules,
    approximate: ruled.approximate,
  }
}

/** "via namespace", "via rules" or null for Unattributed. */
export function viaText(owner: Pick<AttributedOwner, "source" | "label">) {
  if (owner.source === "label") return `via ${owner.label}`
  if (owner.source === "rule") return "via rules"
  return null
}

// Job badges.

/**
 * Owners of each job from `count by (job, chain)` rows: series with a chain
 * label go to its value; the rest to the first job rule matching the job
 * (metric-prefix and label rules need per-metric counts, so they count as
 * Unattributed here). Largest owner first.
 */
export function jobOwnersFromChain(rows: ChainRow[], chain: string[], owners: Owner[]): Map<string, JobOwner[]> {
  const byJob = new Map<string, Map<string, JobOwner>>()
  const jobRule = (job: string) => {
    const cells = [{ job, metric: "", seriesCount: 1 }]
    const jobOnly = owners.map((owner) => ({ ...owner, rules: owner.rules.filter((rule) => rule.kind === "job") }))
    return assignOwnershipCells(cells, jobOnly).owners.find((owned) => owned.series > 0)
  }
  const ruleCache = new Map<string, ReturnType<typeof jobRule>>()
  for (const row of rows) {
    const job = row.labels.job ?? ""
    const dimension = chain.findIndex((label) => (row.labels[label] ?? "") !== "")
    let owner: Omit<JobOwner, "series">
    if (dimension >= 0) {
      const value = row.labels[chain[dimension]]
      owner = { id: labelOwnerId(dimension, value), name: value, color: labelOwnerColor(value), unattributed: false }
    } else {
      if (!ruleCache.has(job)) ruleCache.set(job, jobRule(job))
      const owned = ruleCache.get(job)
      owner = owned
        ? { id: owned.id, name: owned.name, color: owned.color, unattributed: false }
        : { id: UNATTRIBUTED_ID, name: UNATTRIBUTED_NAME, unattributed: true }
    }
    const list = byJob.get(job) ?? new Map<string, JobOwner>()
    byJob.set(job, list)
    const entry = list.get(owner.id) ?? { ...owner, series: 0 }
    entry.series += row.seriesCount
    list.set(owner.id, entry)
  }
  return new Map(Array.from(byJob, ([job, list]) => [job, Array.from(list.values()).sort((a, b) => b.series - a.series)]))
}

// Savings.

export interface OwnerDrilldown {
  /** Top metrics of the owner's series (at most 20). */
  metrics: Array<{ metric: string; series: number }>
  /** Series by the next attribution label (or job). "" = series without it. */
  breakdown: { label: string; values: Array<{ value: string; series: number }> }
}

export interface EstimatedSavings {
  savedSeries: number
  /** Always an estimate for label owners. */
  isEstimate: true
  rules: Array<{ rule: Rule; savedSeries: number }>
}

/**
 * Active-rule savings for a label owner, estimated: each rule's savings
 * scaled by the owner's share of its metric, from the owner's top metrics.
 * Rules on metrics outside the top list count as nothing, so this is a floor.
 */
export function estimateLabelOwnerSavings(
  snapshot: Pick<Snapshot, "metrics" | "seriesByMetricJob" | "totalSeries" | "capturedAt">,
  drilldown: Pick<OwnerDrilldown, "metrics">,
  rules: Rule[],
  drilldowns: Record<string, MetricDrilldown>
): EstimatedSavings {
  const mine = new Map(drilldown.metrics.map((item) => [item.metric, item.series]))
  const totals = new Map(snapshot.metrics.map((item) => [item.metric, item.seriesCount]))
  const byMetric = new Map<string, Rule[]>()
  for (const rule of rules) {
    if (rule.status !== "active" || !mine.has(rule.selector.metric)) continue
    const list = byMetric.get(rule.selector.metric) ?? []
    byMetric.set(rule.selector.metric, list)
    list.push(rule)
  }
  let savedSeries = 0
  const perRule: EstimatedSavings["rules"] = []
  for (const [metric, list] of byMetric) {
    const total = totals.get(metric) ?? 0
    const share = total > 0 ? Math.min(1, (mine.get(metric) ?? 0) / total) : 0
    if (share <= 0) continue
    savedSeries += Math.round(computeExpectedSavings(list, snapshot, drilldowns).savedSeries * share)
    for (const rule of list) perRule.push({ rule, savedSeries: Math.round(computeExpectedSavings([rule], snapshot, drilldowns).savedSeries * share) })
  }
  return { savedSeries, isEstimate: true, rules: perRule }
}

// Agent summary.

const cents = (amount: number) => Math.round(amount * 100) / 100

export function attributionSummary(
  snapshot: Snapshot,
  settings: AttributionSettings,
  attribution: Attribution,
  rules: Rule[],
  drilldowns: Record<string, MetricDrilldown>,
  options: {
    pricePer1k?: number
    topOwners?: number
    topMetrics?: number
    ownerDrilldowns?: Record<string, OwnerDrilldown>
    labelRuleErrors?: Record<string, string>
  } = {}
) {
  const price = typeof options.pricePer1k === "number" && options.pricePer1k > 0 ? options.pricePer1k : undefined
  const cost = (series: number) => (price === undefined ? undefined : cents((series / 1000) * price))
  const topMetrics = options.topMetrics ?? 10
  const rulesById = new Map(settings.owners.map((owner) => [owner.id, owner]))
  const describe = (owner: AttributedOwner) => {
    const base = {
      owner: owner.name,
      via: owner.source === "label" ? owner.label : owner.source === "rule" ? "custom rules" : undefined,
      series: owner.series,
      percent_of_total: owner.percent,
      monthly_cost: cost(owner.series),
    }
    if (owner.ownership) {
      const savings = ruleOwnerSavings(snapshot, owner.ownership, rules, drilldowns)
      const rule = rulesById.get(owner.id)
      return {
        ...base,
        ...(rule ? { owner_rules: rule.rules.map(describeOwnershipRule) } : {}),
        active_rules_save: { series: savings.savedSeries, estimate: savings.isEstimate, monthly_cost: cost(savings.savedSeries) },
        top_metrics: owner.ownership.metrics.slice(0, topMetrics).map((item) => ({ metric: item.metric, series: item.series })),
        top_jobs: owner.ownership.jobs.slice(0, 5).map((item) => ({ job: item.job, series: item.series })),
      }
    }
    const drill = options.ownerDrilldowns?.[owner.id]
    if (!drill) return base
    const savings = estimateLabelOwnerSavings(snapshot, drill, rules, drilldowns)
    return {
      ...base,
      active_rules_save: { series: savings.savedSeries, estimate: true, monthly_cost: cost(savings.savedSeries) },
      top_metrics: drill.metrics.slice(0, topMetrics).map((item) => ({ metric: item.metric, series: item.series })),
      [`by_${drill.breakdown.label}`]: drill.breakdown.values.slice(0, 10).map((item) => ({ value: item.value || null, series: item.series })),
    }
  }
  const top = options.topOwners ?? 15
  const shown = [...attribution.owners].sort((a, b) => b.series - a.series).slice(0, top)
  const errors = options.labelRuleErrors ?? {}
  return {
    attributed_by: attribution.chain,
    fallback: "Each series belongs to its first attribution label's value; series with none go to custom rules, then Unattributed.",
    total_series: attribution.totalSeries,
    cost_note: price === undefined ? "No price set in Cardinal settings, so costs are omitted." : `USD per month at $${price} per 1,000 active series.`,
    savings_note: "Savings for label-attributed owners are estimates from each rule's metric share within the owner's top 20 metrics.",
    owners: shown.map(describe),
    ...(attribution.owners.length > shown.length ? { more_owners: attribution.owners.length - shown.length } : {}),
    unattributed: describe(attribution.unattributed),
    ...(attribution.approximate ? { note: "Some counts are approximate: overlapping label rules, or a legacy snapshot." } : {}),
    ...(Object.keys(errors).length ? { label_rule_errors: errors } : {}),
  }
}
