import { assertLabelName, assertRegex, isLabelName, quoteLabelValue } from "@/lib/core/promql"
import { escapeRegex, regexProblem } from "@/lib/core/regex"
import type { Rule } from "@/lib/core/rules"
import { computeExpectedSavings, snapshotImpact, type Savings } from "@/lib/core/savings"
import { snapshotSeries, toPercent, type Snapshot } from "@/lib/core/snapshot"
import type { JobMetricSeries, MetricDrilldown } from "@/lib/prometheus/types"

// Custom attribution rules ("CODEOWNERS for metrics") for series that none of
// the attribution labels claim (lib/core/attribution.ts). Owners are checked in
// order and the first rule that matches owns the series; the rest is
// Unattributed. Job and metric-prefix rules are exact from job×metric counts;
// label rules need a query per rule (lib/sources/attribution.ts) whose rows are
// merged in per job×metric cell.

export type OwnershipRule =
  | { kind: "job"; pattern: string }
  | { kind: "metric_prefix"; pattern: string }
  | { kind: "label"; label: string; pattern: string }

export interface Owner {
  id: string
  name: string
  color?: string
  rules: OwnershipRule[]
}

export const UNATTRIBUTED_ID = "__unattributed__"
export const UNATTRIBUTED_NAME = "Unattributed"

/** Mid-tone colours that read on light and dark surfaces. */
export const OWNER_COLORS = ["#5b7fd6", "#2a9d8f", "#c0569b", "#d19a1c", "#7d68d0", "#3f97b8", "#8a9a2c", "#d9663f"]

const COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_OWNER_NAME = 80

export function newOwnerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `owner_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function createOwner(name: string, index = 0, rules: OwnershipRule[] = []): Owner {
  return { id: newOwnerId(), name: name.trim() || `Owner ${index + 1}`, color: OWNER_COLORS[index % OWNER_COLORS.length], rules }
}

export function isValidColor(color: unknown): color is string {
  return typeof color === "string" && COLOR.test(color)
}

/** Why a rule can't be used; null when it can. */
export function ownershipRuleProblem(rule: OwnershipRule): string | null {
  if (rule.kind === "label") {
    if (!rule.label) return "label name is empty"
    if (!isLabelName(rule.label)) return "invalid label name"
    if (rule.label === "__name__") return "use a metric prefix rule for metric names"
  }
  const problem = regexProblem(rule.pattern)
  return problem ? `pattern ${problem}` : null
}

/** Stable key of a label rule, shared by its query and the merge. */
export function labelRuleKey(rule: { label: string; pattern: string }) {
  return `${rule.label}=~${rule.pattern}`
}

/** The label rules of all owners that can be queried, deduplicated by key. */
export function queryableLabelRules(owners: Owner[]) {
  const seen = new Map<string, { label: string; pattern: string }>()
  for (const owner of owners) {
    for (const rule of owner.rules) {
      if (rule.kind !== "label" || ownershipRuleProblem(rule)) continue
      seen.set(labelRuleKey(rule), { label: rule.label, pattern: rule.pattern })
    }
  }
  return Array.from(seen, ([key, rule]) => ({ key, ...rule }))
}

const MAX_LABEL_VALUES = 200

/** `,a="",b=""`: matchers for series that lack every label of `chain`. */
export function withoutLabels(chain: string[]) {
  return chain.map((label) => `,${assertLabelName(label)}=""`).join("")
}

/** PromQL for label rules, from validated names and regexes only; run by lib/sources/attribution.ts. */
export const ownerRuleQueries = {
  /** Series per value of `label` across every metric, largest `limit` values (the editor's preview). */
  seriesByLabelValue: (label: string, limit: number) =>
    `topk(${Math.max(1, Math.min(MAX_LABEL_VALUES, Math.floor(limit) || 1))}, count by (${assertLabelName(label)}) ({__name__=~".+"}))`,
  /**
   * Series per job and metric whose `label` matches the rule's regex, merged
   * into the job×metric cells. `chain` limits it to series without any
   * attribution label (the only ones custom rules see).
   */
  seriesMatchingLabel: (label: string, pattern: string, chain: string[] = []) =>
    `count by (job, __name__) ({__name__=~".+"${withoutLabels(chain)},${assertLabelName(label)}=~${quoteLabelValue(assertRegex(pattern))}})`,
}

/** One-line description, e.g. `job =~ payments-.*` or `namespace =~ owner-a`. */
export function describeOwnershipRule(rule: OwnershipRule) {
  switch (rule.kind) {
    case "job":
      return `job =~ ${rule.pattern}`
    case "metric_prefix":
      return `metric starts with ${rule.pattern}`
    case "label":
      return `${rule.label} =~ ${rule.pattern}`
  }
}

type NameMatcher = (value: string) => boolean

function cachedMatcher(regex: RegExp): NameMatcher {
  const cache = new Map<string, boolean>()
  return (value) => {
    let hit = cache.get(value)
    if (hit === undefined) {
      hit = regex.test(value)
      cache.set(value, hit)
    }
    return hit
  }
}

/** Job rules match the whole job; metric-prefix rules match the start of the name. */
function nameMatcher(rule: Exclude<OwnershipRule, { kind: "label" }>): NameMatcher | null {
  if (ownershipRuleProblem(rule)) return null
  try {
    return cachedMatcher(new RegExp(rule.kind === "job" ? `^(?:${rule.pattern})$` : `^(?:${rule.pattern})`))
  } catch {
    return null
  }
}

/** Rows of a label rule's `count by (job, __name__)` query, keyed by `labelRuleKey`. */
export type LabelRuleRows = Record<string, JobMetricSeries[] | undefined>

export interface RuleOwnership {
  id: string
  name: string
  color?: string
  unattributed: boolean
  series: number
  /** Share of all series, 0 to 100. */
  percent: number
  metrics: Array<{ metric: string; series: number }>
  jobs: Array<{ job: string; series: number }>
  /** Series owned per metric, then per job. */
  cells: Map<string, Map<string, number>>
}

export interface Ownership {
  totalSeries: number
  /** In owner order. */
  owners: RuleOwnership[]
  unattributed: RuleOwnership
  /** Keys of label rules whose rows are not loaded yet (they own nothing until then). */
  pendingLabelRules: string[]
  /**
   * True when some counts are not exact: a legacy snapshot without per-job
   * counts, or a job×metric cell matched by more than one label rule (their
   * overlap is unknown).
   */
  approximate: boolean
}

function bucket(id: string, name: string, color: string | undefined, unattributed: boolean): RuleOwnership {
  return { id, name, color, unattributed, series: 0, percent: 0, metrics: [], jobs: [], cells: new Map() }
}

function addCell(target: RuleOwnership, metric: string, job: string, series: number) {
  if (series <= 0) return
  target.series += series
  const byJob = target.cells.get(metric) ?? new Map<string, number>()
  target.cells.set(metric, byJob)
  byJob.set(job, (byJob.get(job) ?? 0) + series)
}

function finish(target: RuleOwnership, totalSeries: number) {
  const jobs = new Map<string, number>()
  target.metrics = Array.from(target.cells, ([metric, byJob]) => {
    let series = 0
    for (const [job, count] of byJob) {
      series += count
      jobs.set(job, (jobs.get(job) ?? 0) + count)
    }
    return { metric, series }
  }).sort((a, b) => b.series - a.series || a.metric.localeCompare(b.metric))
  target.jobs = Array.from(jobs, ([job, series]) => ({ job, series })).sort((a, b) => b.series - a.series || a.job.localeCompare(b.job))
  target.percent = toPercent(target.series, totalSeries)
}

/** Every job×metric cell of the snapshot; legacy snapshots put a metric's series on its top job. */
export function snapshotCells(snapshot: Pick<Snapshot, "metrics" | "seriesByMetricJob">) {
  const cells: JobMetricSeries[] = []
  const table = snapshot.seriesByMetricJob
  if (table) {
    for (const metric of Object.keys(table)) {
      const byJob = table[metric]
      for (const job of Object.keys(byJob)) cells.push({ metric, job, seriesCount: byJob[job] })
    }
    return { cells, exact: true }
  }
  for (const metric of snapshot.metrics) cells.push({ metric: metric.metric, job: metric.topJob ?? "", seriesCount: metric.seriesCount })
  return { cells, exact: false }
}

function rowsIndex(rows: JobMetricSeries[]) {
  const index = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const byJob = index.get(row.metric) ?? new Map<string, number>()
    index.set(row.metric, byJob)
    byJob.set(row.job, (byJob.get(row.job) ?? 0) + row.seriesCount)
  }
  return index
}

type CompiledRule =
  | { kind: "name"; job: NameMatcher | null; metric: NameMatcher | null }
  | { kind: "label"; key: string; index: Map<string, Map<string, number>> | null }

/**
 * Series per owner from the snapshot's job×metric counts. Job and metric-prefix
 * rules are exact. A label rule owns the series its query counted in each cell
 * (capped at what earlier rules left), so it needs `labelRows`.
 */
export function assignOwnership(
  snapshot: Pick<Snapshot, "metrics" | "seriesByMetricJob" | "totalSeries">,
  owners: Owner[],
  labelRows: LabelRuleRows = {}
): Ownership {
  const { cells, exact } = snapshotCells(snapshot)
  return assignOwnershipCells(cells, owners, labelRows, { exact, totalSeries: snapshot.totalSeries })
}

/** `assignOwnership` over any job×metric cells, e.g. the series no attribution label claimed. */
export function assignOwnershipCells(
  cells: JobMetricSeries[],
  owners: Owner[],
  labelRows: LabelRuleRows = {},
  options: { exact?: boolean; totalSeries?: number } = {}
): Ownership {
  const pending = new Set<string>()
  const compiled: CompiledRule[][] = owners.map((owner) =>
    owner.rules.flatMap((rule): CompiledRule[] => {
      if (rule.kind === "label") {
        if (ownershipRuleProblem(rule)) return []
        const key = labelRuleKey(rule)
        const rows = Object.hasOwn(labelRows, key) ? labelRows[key] : undefined
        if (!rows) pending.add(key)
        return [{ kind: "label", key, index: rows ? rowsIndex(rows) : null }]
      }
      const matcher = nameMatcher(rule)
      if (!matcher) return []
      return [{ kind: "name", job: rule.kind === "job" ? matcher : null, metric: rule.kind === "metric_prefix" ? matcher : null }]
    })
  )
  const buckets = owners.map((owner) => bucket(owner.id, owner.name, owner.color, false))
  const unattributed = bucket(UNATTRIBUTED_ID, UNATTRIBUTED_NAME, undefined, true)
  let approximate = options.exact === false

  for (const { metric, job, seriesCount } of cells) {
    let remaining = seriesCount
    let labelHits = 0
    owners: for (let t = 0; t < owners.length; t += 1) {
      for (const rule of compiled[t]) {
        if (remaining <= 0) break owners
        if (rule.kind === "label") {
          const counted = rule.index?.get(metric)?.get(job) ?? 0
          if (counted <= 0) continue
          labelHits += 1
          if (labelHits > 1) approximate = true
          const take = Math.min(remaining, counted)
          addCell(buckets[t], metric, job, take)
          remaining -= take
        } else if ((rule.job && rule.job(job)) || (rule.metric && rule.metric(metric))) {
          addCell(buckets[t], metric, job, remaining)
          remaining = 0
        }
      }
    }
    addCell(unattributed, metric, job, remaining)
  }

  const totalSeries = options.totalSeries ?? cells.reduce((sum, cell) => sum + cell.seriesCount, 0)
  for (const target of [...buckets, unattributed]) finish(target, totalSeries)
  return { totalSeries, owners: buckets, unattributed, pendingLabelRules: Array.from(pending), approximate }
}

export interface JobOwner {
  id: string
  name: string
  color?: string
  unattributed: boolean
  series: number
}

/** Owners of each job, largest share first (Unattributed included). */
export function jobOwners(ownership: Ownership): Map<string, JobOwner[]> {
  const result = new Map<string, JobOwner[]>()
  for (const target of [...ownership.owners, ownership.unattributed]) {
    for (const { job, series } of target.jobs) {
      const list = result.get(job) ?? []
      result.set(job, list)
      list.push({ id: target.id, name: target.name, color: target.color, unattributed: target.unattributed, series })
    }
  }
  for (const list of result.values()) list.sort((a, b) => b.series - a.series)
  return result
}

export interface RulePreview {
  /** Matching names, largest first. */
  names: Array<{ name: string; series: number }>
  series: number
}

/** What a job or metric-prefix rule matches on its own, ignoring earlier owners. Null for label rules or invalid ones. */
export function previewOwnershipRule(snapshot: Pick<Snapshot, "jobs" | "metrics">, rule: OwnershipRule): RulePreview | null {
  if (rule.kind === "label") return null
  const matcher = nameMatcher(rule)
  if (!matcher) return null
  const names =
    rule.kind === "job"
      ? snapshot.jobs.filter((job) => matcher(job.job)).map((job) => ({ name: job.job, series: job.seriesCount }))
      : snapshot.metrics.filter((metric) => matcher(metric.metric)).map((metric) => ({ name: metric.metric, series: metric.seriesCount }))
  names.sort((a, b) => b.series - a.series)
  return { names, series: names.reduce((sum, item) => sum + item.series, 0) }
}

/** A snapshot holding only what one owner owns, for savings and reports. */
export function ownerSnapshot(snapshot: Snapshot, owned: RuleOwnership): Snapshot {
  const seriesByMetricJob: Record<string, Record<string, number>> = Object.create(null)
  const jobsOfMetric = new Map<string, string[]>()
  const metricsOfJob = new Map<string, number>()
  for (const [metric, byJob] of owned.cells) {
    const row: Record<string, number> = Object.create(null)
    for (const [job, count] of byJob) {
      row[job] = count
      metricsOfJob.set(job, (metricsOfJob.get(job) ?? 0) + 1)
    }
    seriesByMetricJob[metric] = row
    jobsOfMetric.set(metric, [...byJob].sort((a, b) => b[1] - a[1]).map(([job]) => job))
  }
  const metrics = owned.metrics.map(({ metric, series }) => {
    const jobs = jobsOfMetric.get(metric) ?? []
    return { metric, seriesCount: series, percentageOfTotal: toPercent(series, owned.series), topJob: jobs[0], jobs }
  })
  return {
    ...snapshot,
    totalSeries: owned.series,
    metricCount: metrics.length,
    labelCount: null,
    topMetrics: metrics.slice(0, snapshot.topN),
    metrics,
    jobs: owned.jobs.map(({ job, series }) => ({
      job,
      seriesCount: series,
      percentageOfTotal: toPercent(series, owned.series),
      metricCount: metricsOfJob.get(job) ?? 0,
    })),
    failedMetrics: [],
    seriesByMetricJob,
  }
}

/** Series of a rule's scope (its metric, in its job or all jobs) that the owner owns. */
function ownedInScope(owned: RuleOwnership, rule: Rule) {
  const byJob = owned.cells.get(rule.selector.metric)
  if (!byJob) return 0
  if (rule.selector.job !== undefined) return byJob.get(rule.selector.job) ?? 0
  let sum = 0
  for (const count of byJob.values()) sum += count
  return sum
}

/**
 * The rules touching a owner's series, with measured impacts scaled to the
 * owner's share of each rule's scope. Metric drops without a measured impact
 * stay as they are: their exact count comes from the owner snapshot.
 */
export function ownerRules(rules: Rule[], snapshot: Snapshot, owned: RuleOwnership): Rule[] {
  return rules.flatMap((rule) => {
    const mine = ownedInScope(owned, rule)
    if (mine <= 0) return []
    if (!rule.impact) return [rule]
    const scope = snapshotSeries(snapshot, rule.selector.metric, rule.selector.job) ?? 0
    const fraction = scope > 0 ? Math.min(1, mine / scope) : 0
    return [
      {
        ...rule,
        impact: {
          ...rule.impact,
          seriesBefore: Math.round(rule.impact.seriesBefore * fraction),
          seriesAfter: Math.round(rule.impact.seriesAfter * fraction),
        },
      },
    ]
  })
}

export interface OwnerSavings extends Savings {
  /** Active rules touching the owner, with the series each saves for it (null = not measured). */
  rules: Array<{ rule: Rule; savedSeries: number | null }>
}

/** Savings of the active rules attributed to one owner, with the shared savings helper. */
export function ruleOwnerSavings(
  snapshot: Snapshot,
  owned: RuleOwnership,
  rules: Rule[],
  drilldowns: Record<string, MetricDrilldown>
): OwnerSavings {
  const scoped = ownerSnapshot(snapshot, owned)
  const active = ownerRules(
    rules.filter((rule) => rule.status === "active"),
    snapshot,
    owned
  )
  const savings = computeExpectedSavings(active, scoped, drilldowns)
  return {
    ...savings,
    rules: active.map((rule) => {
      const impact = rule.impact ?? snapshotImpact(rule, scoped)
      return { rule, savedSeries: impact ? Math.max(0, impact.seriesBefore - impact.seriesAfter) : null }
    }),
  }
}

// Suggestions: jobs grouped by namespace ("payments/api") or by their first
// name token ("payments-api", "payments_worker").

const TOKEN_SPLIT = /[-_.:]/

function suggestionKey(job: string): { name: string; pattern: string } | null {
  if (!job) return null
  const slash = job.indexOf("/")
  if (slash > 0) {
    const namespace = job.slice(0, slash)
    return { name: namespace, pattern: `${escapeRegex(namespace)}/.*` }
  }
  const token = job.split(TOKEN_SPLIT)[0]
  if (token.length < 2 || token === job) return { name: job, pattern: escapeRegex(job) }
  return { name: token, pattern: `${escapeRegex(token)}([-_.:].*)?` }
}

/** Owners guessed from job names, largest first; at most `max`, the rest stays unattributed. */
export function suggestOwners(jobs: Array<{ job: string; seriesCount: number }>, max = 8): Owner[] {
  const groups = new Map<string, { name: string; patterns: Set<string>; series: number }>()
  for (const job of jobs) {
    const key = suggestionKey(job.job)
    if (!key) continue
    const group = groups.get(key.name) ?? { name: key.name, patterns: new Set<string>(), series: 0 }
    groups.set(key.name, group)
    group.series += job.seriesCount
    group.patterns.add(key.pattern)
  }
  return Array.from(groups.values())
    .sort((a, b) => b.series - a.series || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((group, index) => {
      // A bare job ("payments") is already covered by its token's pattern ("payments([-_.:].*)?").
      const token = `${escapeRegex(group.name)}([-_.:].*)?`
      const patterns = [...group.patterns].filter((pattern) => !(group.patterns.has(token) && pattern === escapeRegex(group.name)))
      return createOwner(group.name, index, [{ kind: "job", pattern: patterns.join("|") }])
    })
}

// Import and export: JSON, and a plain text "CODEOWNERS for metrics":
//
//   [Payments] #e6522c
//   job payments-.*
//   metric payments_
//   label namespace payments-.*
//
// A pattern is the rest of the line; one with surrounding spaces or a leading
// quote is written as a JSON string.

export const OWNERS_TEXT_HEADER = [
  "# Cardinal owners: CODEOWNERS for metrics.",
  "# Owners are checked top to bottom; the first matching rule owns a series.",
  "# job <regex> | metric <prefix regex> | label <name> <regex>",
]

function sanitizeName(name: string) {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, MAX_OWNER_NAME)
}

function quotePattern(pattern: string) {
  return pattern === "" || pattern !== pattern.trim() || pattern.startsWith('"') ? JSON.stringify(pattern) : pattern
}

function unquotePattern(text: string) {
  if (!text.startsWith('"')) return text
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

export function ownersToText(owners: Owner[]) {
  const lines = [...OWNERS_TEXT_HEADER]
  for (const owner of owners) {
    lines.push("", `[${sanitizeName(owner.name)}]${isValidColor(owner.color) ? ` ${owner.color}` : ""}`)
    for (const rule of owner.rules) {
      if (rule.kind === "label") lines.push(`label ${rule.label} ${quotePattern(rule.pattern)}`)
      else lines.push(`${rule.kind === "job" ? "job" : "metric"} ${quotePattern(rule.pattern)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export interface ParsedOwners {
  owners: Owner[]
  /** One message per line or entry that was skipped. */
  errors: string[]
}

function checkedRule(rule: OwnershipRule, where: string, errors: string[]) {
  const problem = ownershipRuleProblem(rule)
  if (problem) {
    errors.push(`${where}: ${problem}`)
    return null
  }
  return rule
}

export function parseOwnersText(text: string): ParsedOwners {
  const owners: Owner[] = []
  const errors: string[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    const where = `Line ${index + 1}`
    if (!line || line.startsWith("#")) return
    if (line.startsWith("[")) {
      const end = line.lastIndexOf("]")
      const name = end > 0 ? sanitizeName(line.slice(1, end)) : ""
      if (!name) {
        errors.push(`${where}: a owner needs a name, like [Payments]`)
        return
      }
      const color = line.slice(end + 1).trim()
      if (color && !isValidColor(color)) errors.push(`${where}: ignored colour ${JSON.stringify(color)}`)
      owners.push({ id: newOwnerId(), name, color: isValidColor(color) ? color : OWNER_COLORS[owners.length % OWNER_COLORS.length], rules: [] })
      return
    }
    const owner = owners[owners.length - 1]
    if (!owner) {
      errors.push(`${where}: rule before any [owner] header`)
      return
    }
    const match = /^(\S+)\s+(.*)$/.exec(line)
    const keyword = match?.[1].toLowerCase()
    const rest = match?.[2].trim() ?? ""
    let rule: OwnershipRule | null = null
    if (keyword === "job" || keyword === "metric" || keyword === "metric_prefix") {
      const pattern = unquotePattern(rest)
      if (pattern === null) errors.push(`${where}: unreadable quoted pattern`)
      else rule = { kind: keyword === "job" ? "job" : "metric_prefix", pattern }
    } else if (keyword === "label") {
      const labelMatch = /^(\S+)\s+(.*)$/.exec(rest)
      const pattern = labelMatch ? unquotePattern(labelMatch[2].trim()) : null
      if (!labelMatch || pattern === null) errors.push(`${where}: expected "label <name> <regex>"`)
      else rule = { kind: "label", label: labelMatch[1], pattern }
    } else {
      errors.push(`${where}: expected job, metric or label`)
    }
    const checked = rule && checkedRule(rule, where, errors)
    if (checked) owner.rules.push(checked)
  })
  return { owners, errors }
}

export function ownersToJson(owners: Owner[]) {
  return `${JSON.stringify({ version: 1, owners }, null, 2)}\n`
}

function readRule(value: unknown, where: string, errors: string[]): OwnershipRule | null {
  const raw = (value ?? {}) as Record<string, unknown>
  const pattern = typeof raw.pattern === "string" ? raw.pattern : null
  if (pattern === null) {
    errors.push(`${where}: missing pattern`)
    return null
  }
  if (raw.kind === "job" || raw.kind === "metric_prefix") return checkedRule({ kind: raw.kind, pattern }, where, errors)
  if (raw.kind === "label" && typeof raw.label === "string") return checkedRule({ kind: "label", label: raw.label, pattern }, where, errors)
  errors.push(`${where}: unknown rule kind ${JSON.stringify(raw.kind)}`)
  return null
}

export function parseOwnersJson(text: string): ParsedOwners {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { owners: [], errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  // Files exported before the rename to attribution hold {"teams": [...]}.
  const wrapper = data as { owners?: unknown; teams?: unknown } | null
  const list = Array.isArray(data) ? data : (wrapper?.owners ?? wrapper?.teams)
  if (!Array.isArray(list)) return { owners: [], errors: ['Expected {"owners": [...]} or a list of owners'] }
  const ids = new Set<string>()
  const owners: Owner[] = []
  list.forEach((value, index) => {
    const raw = (value ?? {}) as Record<string, unknown>
    const name = typeof raw.name === "string" ? sanitizeName(raw.name) : ""
    if (!name) {
      errors.push(`Owner ${index + 1}: missing name`)
      return
    }
    let id = typeof raw.id === "string" && raw.id && raw.id.length <= 64 ? raw.id : newOwnerId()
    if (ids.has(id) || id === UNATTRIBUTED_ID) id = newOwnerId()
    ids.add(id)
    const rules = (Array.isArray(raw.rules) ? raw.rules : []).flatMap((rule, ruleIndex) => {
      const checked = readRule(rule, `${name}, rule ${ruleIndex + 1}`, errors)
      return checked ? [checked] : []
    })
    owners.push({ id, name, color: isValidColor(raw.color) ? raw.color : OWNER_COLORS[index % OWNER_COLORS.length], rules })
  })
  return { owners, errors }
}

/** JSON when the text looks like JSON, the text format otherwise. */
export function parseOwners(text: string): ParsedOwners {
  const trimmed = text.trim()
  return /^(\{|\[\s*[{\]])/.test(trimmed) ? parseOwnersJson(trimmed) : parseOwnersText(text)
}
