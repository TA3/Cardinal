// Applying log rules to Grafana Cloud Adaptive Logs, and reverting that apply.
// Pure: lib/sources/adaptive-logs.ts does the HTTP. The remote drop rules are
// merged, never replaced: a rule Cardinal compiled either creates a remote
// rule or updates the one with the same target (segment, selector, levels,
// line substrings). Remote rules Cardinal doesn't know about stay untouched.

import type { AdaptiveLogsDropRule, AdaptiveLogsDropRuleBody } from "@/lib/core/logs/compile/adaptive-logs"
import { tokensToRegex } from "@/lib/core/logs/patterns"
import { normalizeSelector, parseLogSelector, selectorKey } from "@/lib/core/logs/selector"
import type { LogRuleInput } from "@/lib/core/logs/rules"
import type { LineFilter } from "@/lib/core/logs/types"

// Shapes of the Adaptive Logs API (lib/sources/adaptive-logs.ts fetches them).

export interface AdaptiveLogsRecommendation {
  /** The pattern; concatenate in order to rebuild it ("<*>" is a variable part). */
  tokens: string[]
  locked: boolean
  /** Percentage of matching lines dropped now. */
  configured_drop_rate: number
  /** Estimated ingested bytes over the lookback window (15 days). */
  volume: number
  ingested_lines: number
  queried_lines: number
  /** Percentage Adaptive Logs recommends dropping. */
  recommended_drop_rate: number
  superseded: boolean
  levels?: string[]
  segments?: Record<string, unknown>
}

export interface AdaptiveLogsExemption {
  id?: string
  stream_selector: string
  reason?: string
  /** Temporary exemptions only (POST /adaptive-logs/expiring-exemptions), e.g. "1h". */
  active_interval?: string
  expires_at?: string
  created_at?: string
  updated_at?: string
}

/** A canonical selector string when it parses, else the text as sent. */
function canonicalSelector(text: string) {
  try {
    const parsed = parseLogSelector(text)
    if (parsed.filters.length || parsed.rest) return text.trim()
    return selectorKey(normalizeSelector(parsed.selector))
  } catch {
    return text.trim()
  }
}

const sorted = (values: string[] | undefined) => [...(values ?? [])].map((value) => value.toLowerCase()).sort()

/** Identity of a drop rule's target: two rules with the same key act on the same lines. */
export function dropRuleKey(rule: Pick<AdaptiveLogsDropRule, "segment_id" | "body">) {
  return JSON.stringify([
    rule.segment_id,
    canonicalSelector(rule.body.stream_selector),
    sorted(rule.body.levels),
    [...(rule.body.log_line_contains ?? [])].sort(),
  ])
}

export interface DropRuleState {
  drop_rate: number
  disabled: boolean
}

export type LogApplyChange =
  | { type: "create"; rule: AdaptiveLogsDropRule }
  | { type: "update"; before: AdaptiveLogsDropRule; rule: AdaptiveLogsDropRule }

export interface LogApplyPlan {
  changes: LogApplyChange[]
  /** Compiled rules the remote side already has (same target and rate, enabled). */
  unchanged: AdaptiveLogsDropRule[]
  /** Compiled rules left alone because the remote rule already drops more. */
  kept: Array<{ rule: AdaptiveLogsDropRule; remote: AdaptiveLogsDropRule }>
  warnings: string[]
}

/**
 * Merges compiled drop rules into the remote set. A new target is created; an
 * existing one is updated when its rate is lower or it is disabled. A remote
 * rule that already drops more is kept (Cardinal never loosens a remote rule).
 * Updates carry the remote id and version (optimistic concurrency).
 */
export function planLogApply(compiled: AdaptiveLogsDropRule[], existing: AdaptiveLogsDropRule[]): LogApplyPlan {
  const remoteByKey = new Map<string, AdaptiveLogsDropRule>()
  const warnings: string[] = []
  for (const rule of existing) {
    const key = dropRuleKey(rule)
    const current = remoteByKey.get(key)
    // Duplicate remote targets: compare against the strongest enabled one.
    if (!current || (current.disabled && !rule.disabled) || (!rule.disabled && rule.body.drop_rate > current.body.drop_rate)) remoteByKey.set(key, rule)
    if (current) warnings.push(`Grafana Cloud has more than one drop rule for ${rule.body.stream_selector}; Cardinal compares with the strongest.`)
  }
  const changes: LogApplyChange[] = []
  const unchanged: AdaptiveLogsDropRule[] = []
  const kept: LogApplyPlan["kept"] = []
  const seen = new Set<string>()
  for (const rule of compiled) {
    const key = dropRuleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    const remote = remoteByKey.get(key)
    if (!remote) {
      changes.push({ type: "create", rule })
      continue
    }
    if (!remote.disabled && remote.body.drop_rate === rule.body.drop_rate) {
      unchanged.push(remote)
      continue
    }
    if (!remote.disabled && remote.body.drop_rate > rule.body.drop_rate) {
      kept.push({ rule, remote })
      continue
    }
    if (!remote.id) {
      warnings.push(`Can't update the drop rule for ${rule.body.stream_selector}: Grafana Cloud sent it without an id.`)
      continue
    }
    changes.push({
      type: "update",
      before: remote,
      rule: { ...remote, name: remote.name || rule.name, disabled: false, body: { ...remote.body, drop_rate: rule.body.drop_rate } },
    })
  }
  return { changes: dedupe(changes), unchanged, kept, warnings: Array.from(new Set(warnings)) }
}

function dedupe(changes: LogApplyChange[]) {
  const ids = new Set<string>()
  return changes.filter((change) => {
    if (change.type !== "update") return true
    const id = change.before.id!
    if (ids.has(id)) return false
    ids.add(id)
    return true
  })
}

export interface LogApplyDiff {
  type: LogApplyChange["type"]
  name: string
  selector: string
  /** "drop 100% of debug lines", before and after; before is null for a new rule. */
  before: string | null
  after: string
}

/** What a drop rule body does, in one line. */
export function describeDropRule(body: AdaptiveLogsDropRuleBody, disabled = false) {
  const what = [
    body.levels?.length ? `${body.levels.join(", ")} lines` : "lines",
    body.log_line_contains?.length ? `containing ${body.log_line_contains.map((text) => JSON.stringify(text)).join(" and ")}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return `${disabled ? "(disabled) " : ""}drop ${body.drop_rate}% of ${what}`
}

export function logApplyDiffs(plan: Pick<LogApplyPlan, "changes">): LogApplyDiff[] {
  return plan.changes.map((change) => ({
    type: change.type,
    name: change.rule.name,
    selector: change.rule.body.stream_selector,
    before: change.type === "update" ? describeDropRule(change.before.body, change.before.disabled) : null,
    after: describeDropRule(change.rule.body),
  }))
}

// ---- backup and revert ----

export interface LogAdaptiveBackup {
  appliedAt: string
  /** Remote rules as they were before Cardinal updated them (id and version included). */
  updated: AdaptiveLogsDropRule[]
  /** Ids of the rules Cardinal created, recorded as each create returns. */
  created: string[]
  /** What Cardinal wrote, by id, to tell later edits from Cardinal's own. */
  applied: Record<string, AdaptiveLogsDropRuleBody>
  /** Exemptions Cardinal created (ids), removed on revert. */
  exemptions?: string[]
}

export type LogRevertStep =
  | { type: "delete"; id: string; name: string }
  | { type: "restore"; id: string; rule: AdaptiveLogsDropRule }
  | { type: "delete_exemption"; id: string }

export type LogRevertPlan = { ok: true; steps: LogRevertStep[]; missing: number } | { ok: false; reason: string }

function sameBody(a: AdaptiveLogsDropRuleBody | undefined, b: AdaptiveLogsDropRuleBody | undefined) {
  if (!a || !b) return false
  return (
    a.drop_rate === b.drop_rate &&
    canonicalSelector(a.stream_selector) === canonicalSelector(b.stream_selector) &&
    JSON.stringify(sorted(a.levels)) === JSON.stringify(sorted(b.levels)) &&
    JSON.stringify([...(a.log_line_contains ?? [])].sort()) === JSON.stringify([...(b.log_line_contains ?? [])].sort())
  )
}

/**
 * Undoes the last apply: deletes the rules Cardinal created and restores the
 * ones it updated (with their current version). Refuses when any of them was
 * changed since, so a revert never overwrites someone else's edit. Rules that
 * were deleted since are skipped (`missing`).
 */
export function planLogRevert(backup: LogAdaptiveBackup | null, current: AdaptiveLogsDropRule[]): LogRevertPlan {
  if (!backup) return { ok: false, reason: "There is no apply to revert." }
  const byId = new Map(current.filter((rule) => rule.id).map((rule) => [rule.id!, rule]))
  const steps: LogRevertStep[] = []
  let missing = 0
  for (const id of backup.created) {
    const remote = byId.get(id)
    if (!remote) {
      missing += 1
      continue
    }
    if (!sameBody(remote.body, backup.applied[id])) {
      return { ok: false, reason: `"${remote.name}" was changed in Grafana Cloud after Cardinal created it; revert it there instead.` }
    }
    steps.push({ type: "delete", id, name: remote.name })
  }
  for (const before of backup.updated) {
    const remote = before.id ? byId.get(before.id) : undefined
    if (!remote) {
      missing += 1
      continue
    }
    if (!sameBody(remote.body, backup.applied[before.id!]) || remote.disabled) {
      return { ok: false, reason: `"${remote.name}" was changed in Grafana Cloud after Cardinal updated it; revert it there instead.` }
    }
    steps.push({ type: "restore", id: before.id!, rule: { ...before, version: remote.version } })
  }
  for (const id of backup.exemptions ?? []) steps.push({ type: "delete_exemption", id })
  return { ok: true, steps, missing }
}

// ---- recommendations ----

/** Lookback of Adaptive Logs recommendations' `volume` (bytes). */
export const RECOMMENDATION_WINDOW_DAYS = 15

export interface RecommendationRow {
  recommendation: AdaptiveLogsRecommendation
  pattern: string
  /** Estimated ingest per day matching the pattern. */
  bytesPerDay: number
  /** Extra bytes per day dropped if the recommended rate replaced the configured one (0 when it wouldn't drop more). */
  savedBytesPerDay: number
  /** Share of matching lines that queries read, 0–1. */
  queriedShare: number
}

export function recommendationRows(recommendations: AdaptiveLogsRecommendation[]): RecommendationRow[] {
  return recommendations
    .map((recommendation) => {
      const bytesPerDay = Math.max(0, recommendation.volume || 0) / RECOMMENDATION_WINDOW_DAYS
      const delta = Math.max(0, (recommendation.recommended_drop_rate ?? 0) - (recommendation.configured_drop_rate ?? 0)) / 100
      return {
        recommendation,
        pattern: recommendation.tokens.join(""),
        bytesPerDay,
        savedBytesPerDay: bytesPerDay * delta,
        queriedShare: recommendation.ingested_lines > 0 ? Math.min(1, recommendation.queried_lines / recommendation.ingested_lines) : 0,
      }
    })
    .sort((a, b) => b.savedBytesPerDay - a.savedBytesPerDay || b.bytesPerDay - a.bytesPerDay)
}

/**
 * A log rule proposal for a recommendation: sample the pattern's lines at the
 * recommended rate (drop them all at 100%). The pattern is tenant-wide, so the
 * rule has no stream selector; collectors (Alloy, Promtail) can run it, while
 * Adaptive Logs applies its own recommendations in Grafana Cloud. Null when
 * there is nothing to drop or the pattern has no literal text.
 */
export function recommendationToLogRule(recommendation: AdaptiveLogsRecommendation): LogRuleInput | null {
  const rate = recommendation.recommended_drop_rate ?? 0
  if (rate <= 0 || recommendation.locked) return null
  const regex = tokensToRegex(recommendation.tokens)
  if (!regex || !/[A-Za-z0-9]/.test(regex)) return null
  const line: LineFilter = { regex }
  const queried = `${recommendation.queried_lines.toLocaleString("en-US")} of ${recommendation.ingested_lines.toLocaleString("en-US")} lines queried in 15 days`
  const rationale = `Adaptive Logs recommendation: drop ${rate}% of this pattern (${queried}).`
  if (rate >= 100) return { kind: "drop_lines", selector: { matchers: [] }, line, origin: "import", status: "proposed", rationale }
  return { kind: "sample", selector: { matchers: [] }, line, keep: Math.round((100 - rate) * 100) / 10000, origin: "import", status: "proposed", rationale }
}

export function isAdaptiveLogsRecommendation(rule: { origin: string; rationale?: string }) {
  return rule.origin === "import" && Boolean(rule.rationale?.startsWith("Adaptive Logs recommendation"))
}

// ---- exemptions ----

/**
 * The exemptions to create for the keep rules: those Grafana Cloud doesn't
 * have yet (same canonical selector). Cardinal never removes or edits remote
 * exemptions except its own, on revert.
 */
export function planExemptions(wanted: AdaptiveLogsExemption[], existing: AdaptiveLogsExemption[]) {
  const have = new Set(existing.map((item) => canonicalSelector(item.stream_selector)))
  const create: AdaptiveLogsExemption[] = []
  const present: AdaptiveLogsExemption[] = []
  for (const item of wanted) {
    const key = canonicalSelector(item.stream_selector)
    if (have.has(key)) present.push(item)
    else {
      have.add(key)
      create.push(item)
    }
  }
  return { create, present }
}

/**
 * A keep rule for an exemption proposed before keep rules existed (kept in
 * this browser until the next apply). Temporary ones become permanent keeps,
 * which the rationale says.
 */
export function exemptionToKeepRule(exemption: Pick<AdaptiveLogsExemption, "stream_selector" | "reason" | "active_interval">): LogRuleInput | null {
  try {
    const parsed = parseLogSelector(exemption.stream_selector)
    if (parsed.filters.length || parsed.rest || !parsed.selector.matchers.length) return null
    const reason = exemption.reason?.trim() || "Exemption proposed from Adaptive Logs recommendations."
    const rationale = exemption.active_interval ? `${reason} (proposed as a ${exemption.active_interval} exemption)` : reason
    return { kind: "keep", selector: parsed.selector, origin: "user", status: "proposed", rationale: rationale.slice(0, 500) }
  } catch {
    return null
  }
}

/** A pending exemption: proposed in Cardinal, created in Grafana Cloud on Apply. */
export interface PendingExemption extends AdaptiveLogsExemption {
  /** Local id, for removing it before it is applied. */
  key: string
  proposedAt: string
}

/** A Go duration in minutes or hours, e.g. 30m, 1h, 168h. */
const INTERVAL = /^\d{1,5}(m|h)$/

/** Why an exemption can't be proposed; null when it can. */
export function exemptionProblem(exemption: Pick<AdaptiveLogsExemption, "stream_selector" | "active_interval">): string | null {
  try {
    const parsed = parseLogSelector(exemption.stream_selector)
    if (parsed.filters.length || parsed.rest) return "Only a stream selector, without line filters or pipeline stages."
    if (parsed.selector.matchers.length === 0) return "The selector needs at least one matcher."
    if (parsed.selector.matchers.every((matcher) => (matcher.op === "=" && matcher.value === "") || (matcher.op === "=~" && /^(\.\*)?$/.test(matcher.value)))) {
      return "The selector needs a matcher that doesn't match an empty value."
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (exemption.active_interval !== undefined && !INTERVAL.test(exemption.active_interval)) return "Duration looks like 30m, 1h or 168h."
  return null
}
