import { isJobValue, isLabelName, isMetricName } from "@/lib/core/promql"
import { regexProblem } from "@/lib/core/regex"
import { createRule, type Rule, type RuleInput } from "@/lib/core/rules"

// Rule sets as portable JSON: a file download, or base64url in a URL hash
// (`/rules#rules=…`) so a link carries the rules without a server. Anything
// read back is untrusted: every field is validated and the rules come back as
// proposals, never active.

export const RULE_SET_FORMAT = "cardinal.rules"
export const RULE_SET_VERSION = 1
export const SHARE_HASH_KEY = "rules"
const MAX_RULES = 500
const MAX_RATIONALE = 500

export interface SharedRule {
  kind: Rule["kind"]
  metric: string
  job?: string
  labels?: string[]
  match?: { label: string; regex: string }
  buckets?: string[]
  rationale?: string
}

export interface SharedRuleSet {
  format: typeof RULE_SET_FORMAT
  version: typeof RULE_SET_VERSION
  exportedAt?: string
  rules: SharedRule[]
}

function toShared(rule: Rule): SharedRule {
  const base: SharedRule = { kind: rule.kind, metric: rule.selector.metric }
  if (rule.selector.job !== undefined) base.job = rule.selector.job
  if (rule.kind === "drop_labels") base.labels = rule.labels
  if (rule.kind === "drop_series") base.match = rule.match
  if (rule.kind === "keep_buckets") base.buckets = rule.buckets
  if (rule.rationale) base.rationale = rule.rationale
  return base
}

export function toRuleSet(rules: Rule[], exportedAt = new Date().toISOString()): SharedRuleSet {
  return { format: RULE_SET_FORMAT, version: RULE_SET_VERSION, exportedAt, rules: rules.map(toShared) }
}

export function ruleSetJson(rules: Rule[], exportedAt?: string) {
  return `${JSON.stringify(toRuleSet(rules, exportedAt), null, 2)}\n`
}

const LE_VALUE = /^[+-]?(?:Inf|\d*\.?\d+(?:e[+-]?\d+)?)$/i

function clean(text: unknown) {
  if (typeof text !== "string") return undefined
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return flat ? flat.slice(0, MAX_RATIONALE) : undefined
}

function stringList(value: unknown, valid: (item: string) => boolean) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null
  return value.every((item) => typeof item === "string" && valid(item)) ? (value as string[]) : null
}

/** Validates one shared rule; returns a rule input or why it was refused. */
function fromShared(raw: unknown): RuleInput | string {
  if (!raw || typeof raw !== "object") return "not an object"
  const item = raw as Record<string, unknown>
  const metric = typeof item.metric === "string" ? item.metric : ""
  if (!isMetricName(metric)) return `invalid metric name ${JSON.stringify(item.metric)}`
  if (item.job !== undefined && (typeof item.job !== "string" || !isJobValue(item.job))) return `${metric}: invalid job`
  const selector = item.job === undefined ? { metric } : { metric, job: item.job as string }
  const common = { selector, origin: "import" as const, status: "proposed" as const, rationale: clean(item.rationale) }

  switch (item.kind) {
    case "drop_metric":
      return { ...common, kind: "drop_metric" }
    case "drop_labels": {
      const labels = stringList(item.labels, isLabelName)
      return labels ? { ...common, kind: "drop_labels", labels } : `${metric}: invalid labels`
    }
    case "drop_series": {
      const match = item.match as Record<string, unknown> | undefined
      const label = typeof match?.label === "string" ? match.label : ""
      const regex = typeof match?.regex === "string" ? match.regex : ""
      if (!isLabelName(label)) return `${metric}: invalid series label`
      const problem = regexProblem(regex)
      if (problem) return `${metric}: invalid series pattern (${problem})`
      return { ...common, kind: "drop_series", match: { label, regex } }
    }
    case "keep_buckets": {
      const buckets = stringList(item.buckets, (value) => LE_VALUE.test(value))
      return buckets ? { ...common, kind: "keep_buckets", buckets } : `${metric}: invalid buckets`
    }
    default:
      return `unknown rule kind ${JSON.stringify(item.kind)}`
  }
}

export interface ParsedRuleSet {
  rules: Rule[]
  warnings: string[]
}

/** Reads a rule set object (already JSON-parsed). Rules come back as proposals from an import. */
export function fromRuleSet(value: unknown): ParsedRuleSet {
  const set = value as Partial<SharedRuleSet> | null
  if (!set || typeof set !== "object" || set.format !== RULE_SET_FORMAT) {
    throw new Error("Not a Cardinal rule set")
  }
  if (set.version !== RULE_SET_VERSION) throw new Error(`Unsupported rule set version ${String(set.version)}`)
  if (!Array.isArray(set.rules)) throw new Error("The rule set has no rules")
  const warnings: string[] = []
  const rules: Rule[] = []
  set.rules.slice(0, MAX_RULES).forEach((raw, index) => {
    const input = fromShared(raw)
    if (typeof input === "string") warnings.push(`Rule ${index + 1}: ${input}`)
    else rules.push(createRule(input))
  })
  if (set.rules.length > MAX_RULES) warnings.push(`Only the first ${MAX_RULES} rules were read.`)
  return { rules, warnings }
}

export function parseRuleSetJson(text: string): ParsedRuleSet {
  return fromRuleSet(JSON.parse(text))
}

export function base64UrlEncode(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlDecode(encoded: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("The link is not valid base64url")
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
  const binary = atob(padded)
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** The hash fragment for a share link: `#rules=<base64url JSON>`. */
export function shareHash(rules: Rule[], exportedAt?: string) {
  return `#${SHARE_HASH_KEY}=${base64UrlEncode(JSON.stringify(toRuleSet(rules, exportedAt)))}`
}

/** Reads rules from a location hash; null when the hash carries none. Throws on a malformed link. */
export function readShareHash(hash: string): ParsedRuleSet | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const encoded = params.get(SHARE_HASH_KEY)
  if (!encoded) return null
  return parseRuleSetJson(base64UrlDecode(encoded))
}
