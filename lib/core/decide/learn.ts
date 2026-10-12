import type { Assessment, RiskLevel } from "@/lib/core/decide/risk"
import type { StreamSelector } from "@/lib/core/logs/types"

// Learns from what this user accepts and rejects, in this browser only.
// Each decision on a proposal is filed under a few keys describing the cut
// (its kind, the label it drops, the metric namespace, the service...). A
// new cut looks up the most specific key with enough history and reads an
// accept rate from it (Beta(1, 1) smoothed). Counting rather than a fitted
// model: it works from a handful of decisions and explains itself ("you
// accepted 4 of 5 like this").

export type DecisionOutcome = "accept" | "reject"

/** Why a proposal was turned down. "later" snoozes it and teaches nothing. */
export type RejectReason = "used" | "later" | "wrong"

export const REJECT_REASON_LABEL: Record<RejectReason, string> = {
  used: "Something uses it",
  later: "Not now",
  wrong: "Bad suggestion",
}

/** How long "Not now" hides a proposal. */
export const SNOOZE_DAYS = 30

export interface Decision {
  keys: string[]
  outcome: DecisionOutcome
  reason?: RejectReason
  at: string
}

/** Decisions kept; older ones fall off. */
export const MAX_DECISIONS = 500

/** Decisions a specific key needs before it speaks; the broad kind key needs more. */
const MIN_SPECIFIC = 3
const MIN_BROAD = 5

/** A metric's namespace: what comes before the first "_" (e.g. "grafana" in grafana_http_requests_total). */
function namespace(metric: string) {
  const index = metric.indexOf("_")
  return index > 0 ? metric.slice(0, index) : metric
}

/** Keys for a metric rule, broad first. */
export function metricRuleKeys(rule: {
  kind: string
  selector?: { metric: string; job?: string }
  metric?: string
  job?: string
  labels?: string[]
}) {
  const metric = rule.selector?.metric ?? rule.metric ?? ""
  const job = rule.selector?.job ?? rule.job
  const base = `m:${rule.kind}`
  return [
    base,
    ...(rule.labels ?? []).map((label) => `${base}:label=${label}`),
    ...(metric ? [`${base}:ns=${namespace(metric)}`] : []),
    ...(job !== undefined ? [`${base}:job=${job}`] : []),
  ]
}

/** Keys for a log rule, broad first: kind, each exact selector matcher, the label it moves or drops. */
export function logRuleKeys(rule: { kind: string; selector: StreamSelector; label?: string }) {
  const base = `l:${rule.kind}`
  return [
    base,
    ...rule.selector.matchers.filter((matcher) => matcher.op === "=").map((matcher) => `${base}:${matcher.label}=${matcher.value}`),
    ...(rule.label ? [`${base}:label=${rule.label}`] : []),
  ]
}

export interface Preference {
  /** The key the rate comes from. */
  key: string
  accepted: number
  total: number
  /** Smoothed accept rate, (accepted + 1) / (total + 2). */
  rate: number
}

/**
 * The user's track record on cuts like this one: the specific key with the
 * most history (at least 3 decisions), else the broad kind key (at least 5),
 * else null. Snoozes don't count.
 */
export function learnedPreference(decisions: Decision[], keys: string[]): Preference | null {
  if (!keys.length) return null
  const counts = new Map(keys.map((key) => [key, { accepted: 0, total: 0 }]))
  for (const decision of decisions) {
    if (decision.reason === "later") continue
    for (const key of decision.keys) {
      const count = counts.get(key)
      if (!count) continue
      count.total += 1
      if (decision.outcome === "accept") count.accepted += 1
    }
  }
  const [broad, ...specific] = keys
  let best: Preference | null = null
  for (const key of specific) {
    const { accepted, total } = counts.get(key)!
    if (total >= MIN_SPECIFIC && (!best || total > best.total)) best = { key, accepted, total, rate: (accepted + 1) / (total + 2) }
  }
  if (best) return best
  const { accepted, total } = counts.get(broad)!
  return total >= MIN_BROAD ? { key: broad, accepted, total, rate: (accepted + 1) / (total + 2) } : null
}

const DEMOTE: Record<RiskLevel, RiskLevel> = { safe: "review", review: "risky", risky: "risky" }

/**
 * Shifts a static assessment by the user's track record. Mostly rejected
 * (rate ≤ 0.3): one level riskier. Mostly accepted (rate ≥ 0.8): "review"
 * becomes "safe", unless usage couldn't be checked at all. Never turns a
 * "risky" cut safe: evidence of use beats habit.
 */
export function applyPreference(assessment: Assessment, preference: Preference | null): Assessment {
  if (!preference) return assessment
  const { accepted, total, rate } = preference
  const rejected = total - accepted
  if (rate <= 0.3) {
    return {
      ...assessment,
      level: DEMOTE[assessment.level],
      why: [`You turned down ${rejected} of ${total} like this`, ...assessment.why],
      learned: preference,
    }
  }
  if (rate >= 0.8 && assessment.level === "review" && assessment.missing !== "usage") {
    return { ...assessment, level: "safe", why: [`You accepted ${accepted} of ${total} like this`, ...assessment.why], learned: preference }
  }
  return { ...assessment, why: [...assessment.why, `You accepted ${accepted} of ${total} like this`], learned: preference }
}

/** Decisions for proposals moving to active (accept) or rejected (reject); other moves teach nothing. */
export function decisionsFor<T extends { status: string }>(
  rules: T[],
  status: string,
  keysOf: (rule: T) => string[],
  reason?: RejectReason,
  now = new Date()
): Decision[] {
  if (status !== "active" && status !== "rejected") return []
  return rules
    .filter((rule) => rule.status === "proposed")
    .map((rule) => ({
      keys: keysOf(rule),
      outcome: status === "active" ? ("accept" as const) : ("reject" as const),
      ...(status === "rejected" && reason ? { reason } : {}),
      at: now.toISOString(),
    }))
}

/** Appends and keeps the newest MAX_DECISIONS. */
export function appendDecisions(current: Decision[], incoming: Decision[]) {
  return incoming.length ? [...current, ...incoming].slice(-MAX_DECISIONS) : current
}

/** True while a rejected rule is snoozed ("Not now"); a snoozed rule hides its opportunity only until then. */
export function isSnoozed(rule: { status: string; snoozedUntil?: string }, now = Date.now()) {
  return rule.status === "rejected" && rule.snoozedUntil !== undefined && new Date(rule.snoozedUntil).getTime() > now
}

/** A rejected rule whose snooze ran out: it no longer hides its opportunity. */
export function snoozeExpired(rule: { status: string; snoozedUntil?: string }, now = Date.now()) {
  return rule.status === "rejected" && rule.snoozedUntil !== undefined && new Date(rule.snoozedUntil).getTime() <= now
}

export function snoozeUntil(now = new Date()) {
  return new Date(now.getTime() + SNOOZE_DAYS * 86_400_000).toISOString()
}
