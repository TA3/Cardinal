// LogQL stream selectors and line filters for log rules: validation, parsing
// (for importers) and set containment (for shadowing). Rendering goes through
// lib/core/logql.ts after the stricter checks here (no control characters).

import type { LabelMatcher, LineFilter, MatchOp, StreamSelector } from "@/lib/core/logs/types"
import { MATCH_OPS, quoteLogQLValue, streamSelector } from "@/lib/core/logql"
import { isLabelName } from "@/lib/core/promql"
import { escapeRegex, fullMatch, parseLiteralAlternation, regexProblem } from "@/lib/core/regex"

export const MAX_VALUE_LENGTH = 1024
export const MAX_LEVELS = 16
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const LEVEL = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/

/** Matches every stream that has a service_name; Loki needs at least one non-empty matcher. */
export const EVERYTHING: StreamSelector = { matchers: [{ label: "service_name", op: "=~", value: ".+" }] }

export class InvalidSelectorError extends Error {
  constructor(reason: string) {
    super(`Invalid LogQL selector: ${reason}`)
    this.name = "InvalidSelectorError"
  }
}

const isRegexOp = (op: MatchOp) => op === "=~" || op === "!~"

/** Why a matcher can't be used; null when it can. Shared by every log rule and query. */
export function matcherProblem(matcher: LabelMatcher): string | null {
  if (typeof matcher?.label !== "string" || !isLabelName(matcher.label)) {
    return `invalid label name ${JSON.stringify(matcher?.label)}`
  }
  if (!MATCH_OPS.includes(matcher.op)) return `invalid operator ${JSON.stringify(matcher.op)} on ${matcher.label}`
  if (typeof matcher.value !== "string") return `missing value for ${matcher.label}`
  if (matcher.value.length > MAX_VALUE_LENGTH) return `value of ${matcher.label} is longer than ${MAX_VALUE_LENGTH} characters`
  if (CONTROL.test(matcher.value)) return `value of ${matcher.label} contains control characters`
  if (isRegexOp(matcher.op)) {
    const problem = regexProblem(matcher.value)
    if (problem) return `regex for ${matcher.label}: ${problem}`
  }
  return null
}

/** True when the matcher selects only streams that have a non-empty value for its label. */
function isPositive(matcher: LabelMatcher) {
  if (matcher.op === "=") return matcher.value !== ""
  if (matcher.op === "=~") return !fullMatch(matcher.value, "")
  return false
}

/**
 * Why a selector can't be used; null when it can. Loki rejects selectors without
 * a matcher that needs a non-empty value, so `{a!="x"}` or `{a=~".*"}` alone is
 * refused. `allowEmpty` accepts `{}` (meaning every stream) for rules that are
 * not scoped.
 */
export function selectorProblem(selector: StreamSelector, options: { allowEmpty?: boolean } = {}): string | null {
  if (!selector || !Array.isArray(selector.matchers)) return "missing matchers"
  if (selector.matchers.length === 0) return options.allowEmpty ? null : "needs at least one matcher"
  if (selector.matchers.length > 32) return "more than 32 matchers"
  for (const matcher of selector.matchers) {
    const problem = matcherProblem(matcher)
    if (problem) return problem
  }
  if (!selector.matchers.some(isPositive)) return "needs at least one matcher that requires a non-empty value"
  return null
}

function compareMatchers(a: LabelMatcher, b: LabelMatcher) {
  return a.label.localeCompare(b.label) || MATCH_OPS.indexOf(a.op) - MATCH_OPS.indexOf(b.op) || a.value.localeCompare(b.value)
}

/** Sorted, de-duplicated copy: the canonical form used for keys and output. */
export function normalizeSelector(selector: StreamSelector): StreamSelector {
  const seen = new Set<string>()
  const matchers: LabelMatcher[] = []
  for (const { label, op, value } of selector.matchers) {
    const key = JSON.stringify([label, op, value])
    if (seen.has(key)) continue
    seen.add(key)
    matchers.push({ label, op, value })
  }
  return { matchers: matchers.sort(compareMatchers) }
}

export function selectorKey(selector: StreamSelector) {
  return JSON.stringify(normalizeSelector(selector).matchers.map(({ label, op, value }) => [label, op, value]))
}

export function sameSelector(a: StreamSelector, b: StreamSelector) {
  return selectorKey(a) === selectorKey(b)
}

/**
 * `{a="x", b=~"y"}`. Throws on invalid matchers. An empty selector renders as
 * `fallback` (e.g. EVERYTHING for queries) or `{}`.
 */
export function renderSelector(selector: StreamSelector, fallback?: StreamSelector): string {
  const source = selector.matchers.length === 0 && fallback ? fallback : selector
  const problem = selectorProblem(source, { allowEmpty: true })
  if (problem) throw new InvalidSelectorError(problem)
  return source.matchers.length === 0 ? "{}" : streamSelector(source)
}

// ---- line filters ----

const FLAGS = /^\(\?[imsU]+\)/

/** Why a line regex can't be used. Allows RE2 leading flags like `(?i)`, which JS lacks. */
export function lineRegexProblem(regex: string): string | null {
  if (typeof regex !== "string") return "missing regex"
  if (CONTROL.test(regex)) return "contains control characters"
  const body = regex.replace(FLAGS, "")
  if (!body) return "empty"
  return regexProblem(body)
}

export function normalizeLevels(levels: Iterable<string>) {
  return Array.from(new Set(Array.from(levels, (level) => level.trim().toLowerCase()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
}

/** Why a line filter can't be used; exactly one of regex or levels must be set. */
export function lineFilterProblem(line: LineFilter | undefined): string | null {
  if (!line) return "missing line filter"
  const hasRegex = line.regex !== undefined && line.regex !== ""
  const hasLevels = Array.isArray(line.levels) && line.levels.length > 0
  if (hasRegex === hasLevels) return "set either a line regex or levels"
  if (hasRegex) {
    const problem = lineRegexProblem(line.regex!)
    return problem ? `line regex: ${problem}` : null
  }
  if (line.levels!.length > MAX_LEVELS) return `more than ${MAX_LEVELS} levels`
  const bad = line.levels!.find((level) => typeof level !== "string" || !LEVEL.test(level.trim()))
  return bad === undefined ? null : `invalid level ${JSON.stringify(bad)}`
}

export function normalizeLineFilter(line: LineFilter): LineFilter {
  return line.levels?.length ? { levels: normalizeLevels(line.levels) } : { regex: line.regex }
}

export function lineFilterKey(line: LineFilter | undefined) {
  if (!line) return null
  return line.levels?.length ? `levels:${normalizeLevels(line.levels).join(",")}` : `regex:${line.regex ?? ""}`
}

// Levels are matched in the line text (logfmt `level=debug`, JSON `"level":"debug"`).
const LEVEL_KEYS = String.raw`(?i)\b(?:level|lvl|severity)"?\s*[=:]\s*"?`

/** Line regex matching a level written into the line, e.g. `level=debug` or `"level": "debug"`. */
export function levelLineRegex(levels: string[]) {
  return `${LEVEL_KEYS}(?:${normalizeLevels(levels).map(escapeRegex).join("|")})\\b`
}

/** Collector regex that extracts the level from the line into the `level` field. */
export const LEVEL_EXTRACT_REGEX = `${LEVEL_KEYS}(?P<level>[A-Za-z]+)`

/** Anchored, case-insensitive regex over an extracted level value. */
export function levelValueRegex(levels: string[]) {
  return `(?i)^(?:${normalizeLevels(levels).map(escapeRegex).join("|")})$`
}

/** Levels from a regex built by levelLineRegex, else null. */
export function levelsFromLineRegex(regex: string): string[] | null {
  if (!regex.startsWith(`${LEVEL_KEYS}(?:`) || !regex.endsWith(")\\b")) return null
  const names = parseLiteralAlternation(regex.slice(LEVEL_KEYS.length, -2))
  return names && names.length > 0 && names.every((name) => LEVEL.test(name)) ? normalizeLevels(names) : null
}

/** Levels from an anchored level-value regex like `(?i)^(?:debug|trace)$` or `debug|trace`. */
export function levelsFromValueRegex(regex: string): string[] | null {
  const names = parseLiteralAlternation(regex.replace(FLAGS, ""))
  return names && names.length > 0 && names.every((name) => LEVEL.test(name)) ? normalizeLevels(names) : null
}

/** The RE2 regex a line filter applies to the line text. */
export function lineFilterRegex(line: LineFilter) {
  return line.levels?.length ? levelLineRegex(line.levels) : (line.regex ?? "")
}

/** ` |~ "regex"`, or "" without a filter. */
export function renderLineFilter(line: LineFilter | undefined) {
  if (!line) return ""
  const problem = lineFilterProblem(line)
  if (problem) throw new InvalidSelectorError(problem)
  return ` |~ ${quoteLogQLValue(lineFilterRegex(line))}`
}

/** Selector plus optional line filter, e.g. `{app="api"} |~ "health"`. */
export function renderLogSelector(selector: StreamSelector, line?: LineFilter, fallback?: StreamSelector) {
  return `${renderSelector(selector, fallback)}${renderLineFilter(line)}`
}

// ---- parsing ----

export interface ParsedLineFilter {
  op: "|=" | "!=" | "|~" | "!~"
  value: string
}

export interface ParsedLogSelector {
  selector: StreamSelector
  filters: ParsedLineFilter[]
  /** Pipeline stages other than line filters (`| json`, `| level="x"`), which rules can't express. */
  rest: string
}

/** Go/LogQL string literal body to text: JSON escapes, plus Go's that JSON lacks. */
function unquoteGo(body: string) {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|.)/g, (_, esc: string) => {
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\u0007", b: "\b", f: "\f", v: "\v" }
    if (esc in simple) return simple[esc]
    if (/^[xuU]/.test(esc)) return String.fromCodePoint(parseInt(esc.slice(1), 16))
    if (/^[0-7]{3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8))
    return esc
  })
}

class Reader {
  i = 0
  constructor(readonly text: string) {}
  skip() {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i += 1
  }
  peek(n = 1) {
    this.skip()
    return this.text.slice(this.i, this.i + n)
  }
  eat(token: string) {
    if (this.peek(token.length) !== token) return false
    this.i += token.length
    return true
  }
  expect(token: string) {
    if (!this.eat(token)) throw new InvalidSelectorError(`expected ${JSON.stringify(token)} at ${this.i}`)
  }
  ident() {
    this.skip()
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.i))
    if (!match) throw new InvalidSelectorError(`expected a label name at ${this.i}`)
    this.i += match[0].length
    return match[0]
  }
  string() {
    this.skip()
    const quote = this.text[this.i]
    if (quote === "`") {
      const end = this.text.indexOf("`", this.i + 1)
      if (end === -1) throw new InvalidSelectorError("unterminated raw string")
      const value = this.text.slice(this.i + 1, end)
      this.i = end + 1
      return value
    }
    if (quote !== '"') throw new InvalidSelectorError(`expected a string at ${this.i}`)
    let j = this.i + 1
    while (j < this.text.length && this.text[j] !== '"') j += this.text[j] === "\\" ? 2 : 1
    if (j >= this.text.length) throw new InvalidSelectorError("unterminated string")
    const value = unquoteGo(this.text.slice(this.i + 1, j))
    this.i = j + 1
    return value
  }
}

/** Parses `{a="x", b=~"y"} |~ "re" |= "lit"`. Throws InvalidSelectorError. */
export function parseLogSelector(text: string): ParsedLogSelector {
  const reader = new Reader(text)
  reader.expect("{")
  const matchers: LabelMatcher[] = []
  while (!reader.eat("}")) {
    const label = reader.ident()
    const op = (["=~", "!~", "!=", "="] as const).find((candidate) => reader.eat(candidate))
    if (!op) throw new InvalidSelectorError(`expected an operator after ${label}`)
    matchers.push({ label, op, value: reader.string() })
    if (!reader.eat(",")) {
      reader.expect("}")
      break
    }
  }
  const filters: ParsedLineFilter[] = []
  for (;;) {
    const op = (["|=", "!=", "|~", "!~"] as const).find((candidate) => reader.peek(2) === candidate)
    if (!op) break
    reader.eat(op)
    filters.push({ op, value: reader.string() })
  }
  reader.skip()
  return { selector: { matchers }, filters, rest: text.slice(reader.i).trim() }
}

/**
 * Turns parsed line filters into one rule line filter, or explains why not:
 * only a single positive filter maps cleanly (`|= "x"` becomes an escaped regex).
 */
export function lineFilterFromParsed(filters: ParsedLineFilter[]): { line?: LineFilter; problem?: string } {
  if (filters.length === 0) return {}
  if (filters.length > 1) return { problem: "more than one line filter" }
  const [filter] = filters
  if (filter.op === "!=" || filter.op === "!~") return { problem: `negative line filter ${filter.op}` }
  if (filter.op === "|=") return { line: { regex: escapeRegex(filter.value) } }
  const levels = levelsFromLineRegex(filter.value)
  return { line: levels ? { levels } : { regex: filter.value } }
}

// ---- containment ----

/** Literal values a matcher accepts, when it is `=` or a literal alternation; else null. */
function literalValues(matcher: LabelMatcher): string[] | null {
  if (matcher.op === "=") return [matcher.value]
  if (matcher.op === "=~") return parseLiteralAlternation(matcher.value)
  return null
}

/** True when every stream `inner` (one matcher on the same label) selects also passes `outer`. */
function matcherImplies(inner: LabelMatcher, outer: LabelMatcher) {
  if (inner.op === outer.op && inner.value === outer.value) return true
  const values = literalValues(inner)
  if (values) {
    return values.every((value) => {
      switch (outer.op) {
        case "=":
          return value === outer.value
        case "!=":
          return value !== outer.value
        case "=~":
          return fullMatch(outer.value, value)
        case "!~":
          return !fullMatch(outer.value, value)
      }
    })
  }
  // Any other positive inner matcher still requires a non-empty value.
  return outer.op === "!=" && outer.value === "" && isPositive(inner)
}

/** True when `matcher` accepts every stream, including ones without the label. */
function matchesAll(matcher: LabelMatcher) {
  return matcher.op === "=~" && (matcher.value === ".*" || matcher.value === "(.*)")
}

/**
 * True when every stream `inner` selects is also selected by `outer`. Equality
 * is handled exactly; regexes conservatively (literal alternations are
 * expanded, anything else must be the identical matcher), so a false result
 * may still be a subset. An empty `outer` selects everything.
 */
export function selectorContains(outer: StreamSelector, inner: StreamSelector) {
  return outer.matchers.every(
    (matcher) =>
      matchesAll(matcher) ||
      inner.matchers.some((candidate) => candidate.label === matcher.label && matcherImplies(candidate, matcher))
  )
}

/**
 * True when no stream can match both selectors: some label has disjoint
 * literal values on each side (`a="x"` vs `a=~"y|z"`). False when unsure.
 */
export function selectorsDisjoint(a: StreamSelector, b: StreamSelector) {
  return a.matchers.some((left) => {
    const leftValues = literalValues(left)
    if (!leftValues) return false
    return b.matchers.some((right) => {
      if (right.label !== left.label) return false
      if (right.op === "!=" || right.op === "!~") return leftValues.every((value) => !matcherImplies({ ...left, op: "=", value }, right))
      const rightValues = literalValues(right)
      if (rightValues) return !leftValues.some((value) => rightValues.includes(value))
      return !leftValues.some((value) => fullMatch(right.value, value))
    })
  })
}
