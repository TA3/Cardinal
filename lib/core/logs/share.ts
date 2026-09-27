import { createLogRule, LOG_RULE_KINDS, logRuleProblem, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LabelMatcher, LineFilter, LogRule, LogRuleKind, MatchOp } from "@/lib/core/logs/types"
import { base64UrlDecode, base64UrlEncode } from "@/lib/core/share"

// Log rule sets as portable JSON, like lib/core/share.ts for metric rules: a
// file download or base64url in a URL hash (`/rules#logrules=…`). Anything
// read back is untrusted: every field is validated and the rules come back as
// proposals, never active.

export const LOG_RULE_SET_FORMAT = "cardinal.logrules"
export const LOG_RULE_SET_VERSION = 1
export const LOG_SHARE_HASH_KEY = "logrules"
const MAX_RULES = 500
const MAX_RATIONALE = 500
const MAX_MATCHERS = 20
const OPS: readonly MatchOp[] = ["=", "!=", "=~", "!~"]

export interface SharedLogRule {
  kind: LogRuleKind
  selector: LabelMatcher[]
  line?: LineFilter
  keep?: number
  label?: string
  days?: number
  rationale?: string
}

export interface SharedLogRuleSet {
  format: typeof LOG_RULE_SET_FORMAT
  version: typeof LOG_RULE_SET_VERSION
  exportedAt?: string
  rules: SharedLogRule[]
}

function toShared(rule: LogRule): SharedLogRule {
  const base: SharedLogRule = { kind: rule.kind, selector: rule.selector.matchers.map(({ label, op, value }) => ({ label, op, value })) }
  if ((rule.kind === "drop_lines" || rule.kind === "sample" || rule.kind === "keep") && rule.line) base.line = rule.line
  if (rule.kind === "sample") base.keep = rule.keep
  if (rule.kind === "drop_label" || rule.kind === "label_to_metadata") base.label = rule.label
  if (rule.kind === "retention") base.days = rule.days
  if (rule.rationale) base.rationale = rule.rationale
  return base
}

export function toLogRuleSet(rules: LogRule[], exportedAt = new Date().toISOString()): SharedLogRuleSet {
  return { format: LOG_RULE_SET_FORMAT, version: LOG_RULE_SET_VERSION, exportedAt, rules: rules.map(toShared) }
}

export function logRuleSetJson(rules: LogRule[], exportedAt?: string) {
  return `${JSON.stringify(toLogRuleSet(rules, exportedAt), null, 2)}\n`
}

function clean(text: unknown) {
  if (typeof text !== "string") return undefined
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return flat ? flat.slice(0, MAX_RATIONALE) : undefined
}

function readMatchers(value: unknown): LabelMatcher[] | string {
  if (!Array.isArray(value) || value.length > MAX_MATCHERS) return "invalid selector"
  const matchers: LabelMatcher[] = []
  for (const raw of value) {
    const item = (raw ?? {}) as Record<string, unknown>
    if (typeof item.label !== "string" || typeof item.value !== "string" || !OPS.includes(item.op as MatchOp)) return "invalid matcher"
    matchers.push({ label: item.label, op: item.op as MatchOp, value: item.value })
  }
  return matchers
}

function readLine(value: unknown): LineFilter | undefined | string {
  if (value === undefined) return undefined
  const item = (value ?? {}) as Record<string, unknown>
  if (typeof item.regex === "string") return { regex: item.regex }
  if (Array.isArray(item.levels) && item.levels.every((level) => typeof level === "string")) return { levels: item.levels as string[] }
  return "invalid line filter"
}

/** Validates one shared log rule; returns a rule input or why it was refused. */
function fromShared(raw: unknown): LogRuleInput | string {
  if (!raw || typeof raw !== "object") return "not an object"
  const item = raw as Record<string, unknown>
  if (!LOG_RULE_KINDS.includes(item.kind as LogRuleKind)) return `unknown rule kind ${JSON.stringify(item.kind)}`
  const matchers = readMatchers(item.selector)
  if (typeof matchers === "string") return matchers
  const line = readLine(item.line)
  if (typeof line === "string") return line
  const common = { selector: { matchers }, origin: "import" as const, status: "proposed" as const, rationale: clean(item.rationale) }
  let input: LogRuleInput
  switch (item.kind as LogRuleKind) {
    case "drop_streams":
      input = { ...common, kind: "drop_streams" }
      break
    case "drop_lines":
      if (!line) return "drop_lines needs a line filter"
      input = { ...common, kind: "drop_lines", line }
      break
    case "sample":
      input = { ...common, kind: "sample", keep: Number(item.keep), ...(line ? { line } : {}) }
      break
    case "drop_label":
      input = { ...common, kind: "drop_label", label: String(item.label ?? "") }
      break
    case "label_to_metadata":
      input = { ...common, kind: "label_to_metadata", label: String(item.label ?? "") }
      break
    case "retention":
      input = { ...common, kind: "retention", days: Number(item.days) }
      break
    case "keep":
      input = { ...common, kind: "keep", ...(line ? { line } : {}) }
      break
  }
  return logRuleProblem(input) ?? input
}

export interface ParsedLogRuleSet {
  rules: LogRule[]
  warnings: string[]
}

/** Reads a log rule set object (already JSON-parsed). Rules come back as proposals from an import. */
export function fromLogRuleSet(value: unknown): ParsedLogRuleSet {
  const set = value as Partial<SharedLogRuleSet> | null
  if (!set || typeof set !== "object" || set.format !== LOG_RULE_SET_FORMAT) throw new Error("Not a Cardinal log rule set")
  if (set.version !== LOG_RULE_SET_VERSION) throw new Error(`Unsupported log rule set version ${String(set.version)}`)
  if (!Array.isArray(set.rules)) throw new Error("The rule set has no rules")
  const warnings: string[] = []
  const rules: LogRule[] = []
  set.rules.slice(0, MAX_RULES).forEach((raw, index) => {
    const input = fromShared(raw)
    if (typeof input === "string") warnings.push(`Rule ${index + 1}: ${input}`)
    else rules.push(createLogRule(input))
  })
  if (set.rules.length > MAX_RULES) warnings.push(`Only the first ${MAX_RULES} rules were read.`)
  return { rules, warnings }
}

export function parseLogRuleSetJson(text: string): ParsedLogRuleSet {
  return fromLogRuleSet(JSON.parse(text))
}

/** The hash fragment for a log share link: `#logrules=<base64url JSON>`. */
export function logShareHash(rules: LogRule[], exportedAt?: string) {
  return `#${LOG_SHARE_HASH_KEY}=${base64UrlEncode(JSON.stringify(toLogRuleSet(rules, exportedAt)))}`
}

/** Reads log rules from a location hash; null when the hash carries none. Throws on a malformed link. */
export function readLogShareHash(hash: string): ParsedLogRuleSet | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const encoded = params.get(LOG_SHARE_HASH_KEY)
  if (!encoded) return null
  return parseLogRuleSetJson(base64UrlDecode(encoded))
}
