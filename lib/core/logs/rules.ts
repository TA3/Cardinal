// The log rule model: what the user wants to cut from Loki. Mirrors the metric
// rule set in lib/core/rules.ts (status workflow, merge, activate, shadowing)
// but is kept separate, since streams and lines behave differently from series.

import {
  lineFilterKey,
  lineFilterProblem,
  normalizeLineFilter,
  normalizeSelector,
  renderLogSelector,
  renderSelector,
  selectorContains,
  selectorKey,
  selectorProblem,
  selectorsDisjoint,
} from "@/lib/core/logs/selector"
import type {
  DropLabelRule,
  DropLinesRule,
  DropStreamsRule,
  KeepRule,
  LabelToMetadataRule,
  LineFilter,
  LogRule,
  LogRuleKind,
  LogRuleStatus,
  RetentionRule,
  SampleRule,
} from "@/lib/core/logs/types"
import { isLabelName } from "@/lib/core/promql"

export const LOG_RULE_KINDS: readonly LogRuleKind[] = [
  "drop_streams",
  "drop_lines",
  "sample",
  "drop_label",
  "label_to_metadata",
  "retention",
  "keep",
]

/** Retention is whole days; Loki refuses retention_stream periods under 24h. */
export const MIN_RETENTION_DAYS = 1
export const MAX_RETENTION_DAYS = 3650

type Input<T extends LogRule> = Omit<T, "id" | "createdAt" | "status"> & { status?: LogRuleStatus }
export type LogRuleInput =
  | Input<DropStreamsRule>
  | Input<DropLinesRule>
  | Input<SampleRule>
  | Input<DropLabelRule>
  | Input<LabelToMetadataRule>
  | Input<RetentionRule>
  | Input<KeepRule>

export class InvalidLogRuleError extends Error {
  constructor(reason: string) {
    super(`Invalid log rule: ${reason}`)
    this.name = "InvalidLogRuleError"
  }
}

/** Kinds that may use an empty selector, meaning every stream. */
const UNSCOPED_OK = new Set<LogRuleKind>(["drop_lines", "sample", "drop_label", "label_to_metadata"])
const RESERVED_LABELS = new Set(["service_name", "__stream_shard__"])

/** Longest keep rationale kept (it ends up in comments and exemption reasons). */
export const MAX_RATIONALE = 500

/** Why a rule (or rule input) can't be used; null when it can. */
export function logRuleProblem(rule: LogRuleInput | LogRule): string | null {
  if (!rule || !LOG_RULE_KINDS.includes(rule.kind)) return `unknown kind ${JSON.stringify(rule?.kind)}`
  // A keep may cover every stream only for some lines: "keep everything" would protect it all.
  const unscoped = UNSCOPED_OK.has(rule.kind) || (rule.kind === "keep" && rule.line !== undefined)
  const selector = selectorProblem(rule.selector, { allowEmpty: unscoped })
  if (selector) return `selector: ${selector}`
  switch (rule.kind) {
    case "drop_lines":
      return lineFilterProblem(rule.line)
    case "sample":
      if (rule.line !== undefined) {
        const problem = lineFilterProblem(rule.line)
        if (problem) return problem
      }
      if (typeof rule.keep !== "number" || !Number.isFinite(rule.keep) || rule.keep <= 0 || rule.keep >= 1) {
        return "keep must be between 0 and 1 (exclusive); use drop_lines to drop everything"
      }
      return null
    case "drop_label":
    case "label_to_metadata":
      if (typeof rule.label !== "string" || !isLabelName(rule.label)) return `invalid label name ${JSON.stringify(rule.label)}`
      if (rule.label.startsWith("__")) return `${rule.label} is internal`
      if (rule.kind === "label_to_metadata" && RESERVED_LABELS.has(rule.label)) return `${rule.label} must stay a stream label`
      if (rule.selector.matchers.some((matcher) => matcher.label === rule.label)) {
        return `the selector uses ${rule.label} itself`
      }
      return null
    case "retention":
      if (!Number.isInteger(rule.days) || rule.days < MIN_RETENTION_DAYS || rule.days > MAX_RETENTION_DAYS) {
        return `days must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`
      }
      return null
    case "keep":
      if (rule.line !== undefined) {
        const problem = lineFilterProblem(rule.line)
        if (problem) return problem
      }
      if (typeof rule.rationale !== "string" || !rule.rationale.trim()) return "a keep rule needs a rationale (why these lines must stay)"
      if (rule.rationale.length > MAX_RATIONALE) return `the rationale is longer than ${MAX_RATIONALE} characters`
      return null
    default:
      return null
  }
}

export function isValidLogRule(rule: LogRuleInput | LogRule) {
  return logRuleProblem(rule) === null
}

function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Validates and normalizes (sorted matchers, lower-case levels). Throws InvalidLogRuleError. */
export function createLogRule(input: LogRuleInput): LogRule {
  const problem = logRuleProblem(input)
  if (problem) throw new InvalidLogRuleError(problem)
  const base = {
    ...input,
    selector: normalizeSelector(input.selector),
    id: newId(),
    createdAt: new Date().toISOString(),
    status: input.status ?? "active",
  }
  if (base.kind === "drop_lines") return { ...base, line: normalizeLineFilter(base.line) }
  if (base.kind === "sample" || base.kind === "keep") {
    const { line, ...rest } = base
    return line ? { ...rest, line: normalizeLineFilter(line) } : rest
  }
  return base as LogRule
}

type KeyedLogRule = Pick<LogRule, "kind" | "selector"> & { line?: LineFilter; label?: string }

/**
 * Identity of a rule's target: kind, canonical selector, plus the line filter
 * (drop_lines, sample) or label (drop_label, label_to_metadata). A sample's keep
 * and a retention's days are settings of the rule, not part of its identity.
 */
export function logRuleKey(rule: KeyedLogRule | LogRuleInput) {
  const keyed = rule as KeyedLogRule
  const base: unknown[] = [rule.kind, selectorKey(rule.selector)]
  if (rule.kind === "drop_lines" || rule.kind === "sample" || rule.kind === "keep") base.push(lineFilterKey(keyed.line))
  if (rule.kind === "drop_label" || rule.kind === "label_to_metadata") base.push(keyed.label)
  return JSON.stringify(base)
}

export interface LogMergeResult {
  rules: LogRule[]
  /** Incoming rules that were added or folded into an existing rule. */
  added: LogRule[]
  /** Incoming rules that changed nothing: duplicates, or proposals an active rule already covers. */
  skipped: LogRule[]
}

/** True when `other` (same key) changes nothing once `rule` applies: it cuts at least as much. */
function covers(rule: LogRule, other: LogRule) {
  if (rule.kind === "sample" && other.kind === "sample") return rule.keep <= other.keep
  if (rule.kind === "retention" && other.kind === "retention") return rule.days <= other.days
  return true
}

/** Folds `rule` into `current` (same key and status): the stronger setting wins. Null when there's nothing to fold. */
function fold(current: LogRule, rule: LogRule): LogRule | null {
  if (current.kind === "sample" && rule.kind === "sample") return { ...current, keep: rule.keep, impact: undefined }
  if (current.kind === "retention" && rule.kind === "retention") return { ...current, days: rule.days, impact: undefined }
  return null
}

/**
 * Adds rules to a set, like metrics mergeRules: only rules with the same key
 * and status merge (a lower keep or shorter retention wins), so a proposal
 * never folds into an active or rejected rule and skips review. A proposal an
 * active rule already covers is skipped. Existing rules keep their id/status.
 */
export function mergeLogRules(existing: LogRule[], incoming: LogRule[]): LogMergeResult {
  const rules = [...existing]
  const added: LogRule[] = []
  const skipped: LogRule[] = []
  const find = (key: string, status: LogRuleStatus) =>
    rules.findIndex((rule) => rule.status === status && logRuleKey(rule) === key)

  for (const rule of incoming) {
    const key = logRuleKey(rule)
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
 * Makes `candidate` active: updates an active rule with the same key, else
 * activates a proposed (then rejected) one, else adds it. The candidate's keep
 * or days replace the existing rule's.
 */
export function activateOrCreateLogRule(rules: LogRule[], candidate: LogRuleInput): LogRule[] {
  const key = logRuleKey(candidate)
  const index = (["active", "proposed", "rejected"] as const)
    .map((status) => rules.findIndex((rule) => rule.status === status && logRuleKey(rule) === key))
    .find((found) => found !== -1)
  if (index === undefined) return [...rules, createLogRule({ ...candidate, status: "active" })]

  const current = rules[index]
  let next: LogRule = current.status === "active" ? current : { ...current, status: "active" }
  if (next.kind === "sample" && candidate.kind === "sample" && next.keep !== candidate.keep) {
    if (logRuleProblem(candidate)) throw new InvalidLogRuleError(logRuleProblem(candidate)!)
    next = { ...next, keep: candidate.keep, impact: undefined }
  }
  if (next.kind === "retention" && candidate.kind === "retention" && next.days !== candidate.days) {
    if (logRuleProblem(candidate)) throw new InvalidLogRuleError(logRuleProblem(candidate)!)
    next = { ...next, days: candidate.days, impact: undefined }
  }
  return next === current ? rules : rules.map((rule, i) => (i === index ? next : rule))
}

/** Removes the active rule with the candidate's key, or activates/creates it. */
export function toggleLogRule(rules: LogRule[], candidate: LogRuleInput): LogRule[] {
  const key = logRuleKey(candidate)
  const active = rules.find((rule) => rule.status === "active" && logRuleKey(rule) === key)
  if (active) return rules.filter((rule) => rule !== active)
  return activateOrCreateLogRule(rules, candidate)
}

/** Rules with the same key and status merged, keeping the first one's id (after a status change). */
export function foldLogRules(rules: LogRule[]): LogRule[] {
  const result: LogRule[] = []
  for (const rule of rules) {
    const index = result.findIndex((other) => other.status === rule.status && logRuleKey(other) === logRuleKey(rule))
    if (index === -1) {
      result.push(rule)
      continue
    }
    const current = result[index]
    if (!covers(current, rule)) result[index] = fold(current, rule) ?? current
  }
  return result
}

export function activeLogRules(rules: LogRule[]) {
  return rules.filter((rule) => rule.status === "active")
}

const sameLine = (a: LineFilter | undefined, b: LineFilter | undefined) => lineFilterKey(a) === lineFilterKey(b)

/**
 * The active rule that makes `rule` redundant, if any:
 * - a drop_streams whose selector contains `rule`'s covers every kind (its
 *   streams are gone); between two drop_streams the broader one wins, and for
 *   identical selectors the earlier one;
 * - a drop_lines with the same filter and a containing selector covers a
 *   narrower drop_lines or a sample of the same lines.
 */
export function logRuleShadowedBy(rule: LogRule, rules: LogRule[]): LogRule | undefined {
  const position = rules.indexOf(rule)
  return rules.find((other, index) => {
    if (other === rule || other.id === rule.id || other.status !== "active") return false
    // Keeps protect lines from drops: only another keep makes one redundant.
    if ((rule.kind === "keep") !== (other.kind === "keep")) return false
    if (!selectorContains(other.selector, rule.selector)) return false
    const equal = selectorContains(rule.selector, other.selector)
    const earlier = position === -1 || index < position
    if (other.kind === "drop_streams") return rule.kind !== "drop_streams" || !equal || earlier
    if (other.kind === "drop_lines") {
      if (rule.kind === "drop_lines" && sameLine(other.line, rule.line)) return !equal || earlier
      if (rule.kind === "sample" && sameLine(other.line, rule.line)) return true
    }
    // A broader keep of the same lines (or of every line) makes a narrower keep redundant.
    if (other.kind === "keep" && rule.kind === "keep" && (!other.line || sameLine(other.line, rule.line))) return !equal || earlier
    return false
  })
}

/** Kinds that remove lines, which keep rules protect against. */
export const LINE_REMOVING_KINDS: readonly LogRuleKind[] = ["drop_streams", "drop_lines", "sample"]

/**
 * The active keep rules that protect some of `rule`'s lines: keeps whose
 * streams may overlap it. Only line-removing rules (drops and samples) have any.
 */
export function logRuleKeeps(rule: LogRule, rules: LogRule[]): KeepRule[] {
  if (!LINE_REMOVING_KINDS.includes(rule.kind)) return []
  return rules.filter(
    (other): other is KeepRule => other.kind === "keep" && other.status === "active" && other.id !== rule.id && !selectorsDisjoint(other.selector, rule.selector)
  )
}

/**
 * True when `keep` protects every line a rule on `selector` (with `line`) would
 * remove: it covers the rule's streams, and keeps every line or the same lines.
 */
export function keepCoversAll(keep: Pick<KeepRule, "selector" | "line">, selector: LogRule["selector"], line?: LineFilter) {
  return selectorContains(keep.selector, selector) && (!keep.line || (line !== undefined && sameLine(keep.line, line)))
}

/** The active keep that protects every line `rule` would remove, if any. */
export function logRuleProtectedBy(rule: LogRule, rules: LogRule[]): KeepRule | undefined {
  const line = rule.kind === "drop_lines" || rule.kind === "sample" ? rule.line : undefined
  return logRuleKeeps(rule, rules).find((keep) => keepCoversAll(keep, rule.selector, line))
}

export function isLogRuleShadowed(rule: LogRule, rules: LogRule[]) {
  return logRuleShadowedBy(rule, rules) !== undefined
}

function safeSelector(rule: Pick<LogRule, "selector">) {
  if (rule.selector.matchers.length === 0) return "all streams"
  try {
    return renderSelector(rule.selector)
  } catch {
    return "(invalid selector)"
  }
}

function describeLine(line: LineFilter) {
  if (line.levels?.length) return `${line.levels.join(", ")} lines`
  return `lines matching /${line.regex}/`
}

function percent(value: number) {
  const pct = value * 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(pct < 1 ? 2 : 1)}%`
}

/** One-line description for the UI, e.g. `Drop debug, trace lines in {service_name="api"}`. */
export function describeLogRule(rule: LogRule | LogRuleInput): string {
  const scope = safeSelector(rule)
  switch (rule.kind) {
    case "drop_streams":
      return `Drop streams ${scope}`
    case "drop_lines":
      return `Drop ${describeLine(rule.line)} in ${scope}`
    case "sample":
      return `Keep ${percent(rule.keep)} of ${rule.line ? describeLine(rule.line) : "lines"} in ${scope}`
    case "drop_label":
      return `Drop label ${rule.label} from ${scope}`
    case "label_to_metadata":
      return `Move label ${rule.label} to structured metadata in ${scope}`
    case "retention":
      return `Keep ${scope} for ${rule.days} day${rule.days === 1 ? "" : "s"}`
    case "keep":
      return `Protect ${rule.line ? describeLine(rule.line) : "every line"} in ${scope} from drops`
  }
}

/** The LogQL a rule targets (selector plus line filter), for display and queries. */
export function logRuleSelector(rule: LogRule | LogRuleInput, fallback?: Parameters<typeof renderSelector>[1]) {
  const line = rule.kind === "drop_lines" || rule.kind === "sample" || rule.kind === "keep" ? rule.line : undefined
  return renderLogSelector(rule.selector, line, fallback)
}

/** What the Patterns page's former "Keep" wrote: a rejected drop_lines with this rationale. */
const KEEP_HACK = /^Kept on purpose: pattern /

/**
 * Turns the rejected drop_lines rules the Patterns page used to file for
 * "Keep" into real keep rules (active, same selector, line and rationale).
 * Anything else is left as it is.
 */
export function migrateKeepHacks(rules: LogRule[]): LogRule[] {
  return rules.map((rule) => {
    if (rule.kind !== "drop_lines" || rule.status !== "rejected" || !KEEP_HACK.test(rule.rationale ?? "")) return rule
    const { line, ...rest } = rule
    const keep: KeepRule = { ...rest, kind: "keep", line, status: "active", impact: undefined }
    return logRuleProblem(keep) ? rule : keep
  })
}
