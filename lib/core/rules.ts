// The rule model shared by the UI, the config importers/compilers and the MCP
// agent. A RuleSet is the single source of truth for "what the user wants to cut".

export type RuleOrigin = "user" | "import" | "agent"
export type RuleStatus = "active" | "proposed" | "rejected"

export interface RuleSelector {
  metric: string
  /** When set, the rule only applies to series with this job label. */
  job?: string
}

export interface RuleImpact {
  seriesBefore: number
  seriesAfter: number
  /** True when measured with an exact query rather than a heuristic. */
  exact: boolean
  /**
   * True when removing the labels merges distinct series. What happens then is
   * the rule's `onMerge` choice (see DropLabelsRule).
   */
  mergesSeries: boolean
  measuredAt: string
}

interface RuleBase {
  id: string
  selector: RuleSelector
  origin: RuleOrigin
  status: RuleStatus
  rationale?: string
  impact?: RuleImpact
  createdAt: string
}

export interface DropMetricRule extends RuleBase {
  kind: "drop_metric"
}

/**
 * What a label drop that merges series does. "drop": relabel the labels away
 * anyway (the backend keeps one sample per merged group each scrape).
 * "keep_value": keep only the series with one chosen value per label, then
 * drop the label, so nothing merges. "aggregate": sum the merged series
 * (Adaptive Metrics on Grafana Cloud, a recording rule on remote write).
 */
export type MergeChoice = "drop" | "keep_value" | "aggregate"

export interface DropLabelsRule extends RuleBase {
  kind: "drop_labels"
  labels: string[]
  /** Unset until the user decides (only matters when the drop merges series). */
  onMerge?: MergeChoice
  /** For "keep_value": the value kept per label. */
  keepValues?: Record<string, string>
}

/** A value condition on one label: series whose `label` matches `regex` (RE2, fully anchored). */
export interface SeriesMatch {
  label: string
  regex: string
}

/**
 * Drops the series of a metric whose label matches a value pattern, e.g. every
 * `path` under `/api/v1/users/.+`. Drops whole series, so it never merges any.
 */
export interface DropSeriesRule extends RuleBase {
  kind: "drop_series"
  match: SeriesMatch
}

/**
 * Keeps only the listed `le` buckets of a classic histogram's `_bucket`
 * metric; every other bucket series is dropped. `+Inf` is always kept, since
 * `histogram_quantile` needs it.
 */
export interface KeepBucketsRule extends RuleBase {
  kind: "keep_buckets"
  buckets: string[]
}

export type Rule = DropMetricRule | DropLabelsRule | DropSeriesRule | KeepBucketsRule
export type RuleKind = Rule["kind"]
type Input<T extends Rule> = Omit<T, "id" | "createdAt" | "status"> & { status?: RuleStatus }
export type RuleInput = Input<DropMetricRule> | Input<DropLabelsRule> | Input<DropSeriesRule> | Input<KeepBucketsRule>

type KeyedRule =
  | Pick<DropMetricRule | DropLabelsRule | KeepBucketsRule, "kind" | "selector">
  | Pick<DropSeriesRule, "kind" | "selector" | "match">

/**
 * Identity of a rule's target; job `undefined` (every job) and `""` (no job)
 * differ. Series drops are also told apart by their value condition.
 */
export function ruleKey(rule: KeyedRule) {
  const base = [rule.kind, rule.selector.job ?? null, rule.selector.metric]
  if (rule.kind === "drop_series") base.push(rule.match.label, rule.match.regex)
  return JSON.stringify(base)
}

export const INF_BUCKET = "+Inf"

/** Sorts `le` values numerically ("+Inf" last) and always includes "+Inf". */
export function normalizeBuckets(buckets: Iterable<string>) {
  const values = new Set(Array.from(buckets, (value) => value.trim()).filter(Boolean))
  values.add(INF_BUCKET)
  const num = (value: string) => (value === INF_BUCKET ? Infinity : Number(value))
  return Array.from(values).sort((a, b) => {
    const diff = num(a) - num(b)
    return Number.isNaN(diff) ? a.localeCompare(b) : diff || a.localeCompare(b)
  })
}

function newId() {
  // randomUUID is missing outside secure contexts (e.g. plain-http LAN access).
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createRule(input: RuleInput): Rule {
  const base = {
    ...input,
    id: newId(),
    createdAt: new Date().toISOString(),
    status: input.status ?? "active",
  }
  if (base.kind === "drop_labels") {
    return { ...base, labels: sortUnique(base.labels) }
  }
  if (base.kind === "keep_buckets") {
    return { ...base, buckets: normalizeBuckets(base.buckets) }
  }
  if (base.kind === "drop_series") {
    return { ...base, match: { label: base.match.label, regex: base.match.regex } }
  }
  return base as DropMetricRule
}

export function sortUnique(values: Iterable<string>) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

export interface MergeResult {
  rules: Rule[]
  /** Incoming rules that were added or folded into an existing rule. */
  added: Rule[]
  /** Incoming rules that changed nothing: duplicates, or proposals an active rule already covers. */
  skipped: Rule[]
}

/** True when `other` (same key) changes nothing once `rule` applies. */
function covers(rule: Rule, other: Rule) {
  if (rule.kind === "drop_metric") return true
  if (rule.kind === "drop_series") return other.kind === "drop_series"
  if (rule.kind === "keep_buckets") {
    // Keeping fewer buckets drops more: a rule keeping a subset covers the other.
    return other.kind === "keep_buckets" && rule.buckets.every((bucket) => other.buckets.includes(bucket))
  }
  if (other.kind !== "drop_labels") return false
  return other.labels.every((label) => rule.labels.includes(label))
}

/**
 * Folds `rule` into `current` (same key and status): label drops union their
 * labels, bucket keeps intersect (both relabel steps would run, so only the
 * buckets both keep survive). Null when the kinds can't be folded.
 */
function fold(current: Rule, rule: Rule): Rule | null {
  if (current.kind === "drop_labels" && rule.kind === "drop_labels") {
    return { ...current, ...foldMerge(current, rule), labels: sortUnique([...current.labels, ...rule.labels]), impact: undefined }
  }
  if (current.kind === "keep_buckets" && rule.kind === "keep_buckets") {
    return { ...current, buckets: normalizeBuckets(current.buckets.filter((bucket) => rule.buckets.includes(bucket))), impact: undefined }
  }
  return null
}

/** The merge handling after folding `rule` into `current`: the current choice wins, kept values combine. */
function foldMerge(current: DropLabelsRule, rule: Pick<DropLabelsRule, "onMerge" | "keepValues">) {
  const onMerge = current.onMerge ?? rule.onMerge
  if (!onMerge) return {}
  const keepValues = onMerge === "keep_value" ? { ...rule.keepValues, ...current.keepValues } : undefined
  return { onMerge, ...(keepValues ? { keepValues } : {}) }
}

/**
 * Adds rules to a set. Only rules with the same key and status are merged
 * (label drops are unioned), so a proposal never folds into an active or
 * rejected rule and skips review. A proposal already covered by an active rule
 * is skipped. Existing rules keep their id/status.
 */
export function mergeRules(existing: Rule[], incoming: Rule[]): MergeResult {
  const rules = [...existing]
  const added: Rule[] = []
  const skipped: Rule[] = []
  const find = (key: string, status: RuleStatus) =>
    rules.findIndex((rule) => rule.status === status && ruleKey(rule) === key)

  for (const rule of incoming) {
    const key = ruleKey(rule)
    if (rule.status === "proposed") {
      const active = rules[find(key, "active")]
      if (active && covers(active, rule)) {
        skipped.push(rule)
        continue
      }
    }
    const index = find(key, rule.status)
    const current = rules[index]
    if (!current) {
      rules.push(rule)
      added.push(rule)
    } else if (covers(current, rule)) {
      skipped.push(rule)
    } else {
      const folded = fold(current, rule)
      if (folded) {
        rules[index] = folded
        added.push(rule)
      } else {
        skipped.push(rule)
      }
    }
  }
  return { rules, added, skipped }
}

/**
 * Makes `candidate` active: folds it into an active rule with the same key,
 * else activates a proposed (then rejected) one, merging label drops, else
 * adds it as a new active rule.
 */
export function activateOrCreate(rules: Rule[], candidate: RuleInput): Rule[] {
  const key = ruleKey(candidate)
  const labels = candidate.kind === "drop_labels" ? candidate.labels : []
  const index = (["active", "proposed", "rejected"] as const)
    .map((status) => rules.findIndex((rule) => rule.status === status && ruleKey(rule) === key))
    .find((found) => found !== -1)
  if (index === undefined) return [...rules, createRule({ ...candidate, status: "active" })]

  const current = rules[index]
  let next: Rule = current.status === "active" ? current : { ...current, status: "active" }
  if (next.kind === "drop_labels") {
    const merged = sortUnique([...next.labels, ...labels])
    if (merged.length !== next.labels.length) next = { ...next, labels: merged, impact: undefined }
    if (candidate.kind === "drop_labels" && candidate.onMerge && candidate.onMerge !== next.onMerge) {
      next = { ...next, onMerge: candidate.onMerge, keepValues: candidate.onMerge === "keep_value" ? candidate.keepValues : undefined }
    }
  }
  if (next.kind === "keep_buckets" && candidate.kind === "keep_buckets") {
    const buckets = normalizeBuckets(candidate.buckets)
    if (buckets.join() !== next.buckets.join()) next = { ...next, buckets, impact: undefined }
  }
  return next === current ? rules : rules.map((rule, i) => (i === index ? next : rule))
}

export function activeRules(rules: Rule[]) {
  return rules.filter((rule) => rule.status === "active")
}

/**
 * The active rule that makes `rule` redundant, if any: a metric drop on the same
 * or broader scope covers every other kind; a global metric drop covers a
 * job-scoped one; a global label drop covers a job-scoped drop of a subset of
 * its labels.
 */
export function shadowedBy(rule: Rule, rules: Rule[]): Rule | undefined {
  const { metric, job } = rule.selector
  return rules.find((other) => {
    if (other === rule || other.id === rule.id || other.status !== "active" || other.selector.metric !== metric) return false
    const broader = other.selector.job === undefined && job !== undefined
    if (other.kind === "drop_metric") {
      return rule.kind === "drop_metric" ? broader : broader || other.selector.job === job
    }
    if (other.kind === "drop_labels" && rule.kind === "drop_labels") {
      return broader && sameMergeHandling(rule, other) && rule.labels.every((label) => other.labels.includes(label))
    }
    return false
  })
}

/** True when two label drops treat merged series the same way (choice and kept values). */
export function sameMergeHandling(a: DropLabelsRule, b: DropLabelsRule) {
  const keep = (rule: DropLabelsRule) =>
    rule.onMerge === "keep_value" ? JSON.stringify(Object.entries(rule.keepValues ?? {}).sort(([x], [y]) => x.localeCompare(y))) : ""
  return (a.onMerge ?? null) === (b.onMerge ?? null) && keep(a) === keep(b)
}

/** True when the rule is a label drop measured to merge series. */
export function mergesSeries(rule: Rule): rule is DropLabelsRule {
  return rule.kind === "drop_labels" && Boolean(rule.impact?.mergesSeries)
}

/**
 * How a merging label drop is handled: the stored choice, else "drop" when
 * nothing is known to use the labels (`unused`), else null (the user decides).
 */
export function mergeChoiceOf(rule: DropLabelsRule, unused?: boolean): MergeChoice | null {
  return rule.onMerge ?? (unused ? "drop" : null)
}

/** True when another active rule already does everything this one does. */
export function isShadowed(rule: Rule, rules: Rule[]) {
  return shadowedBy(rule, rules) !== undefined
}
