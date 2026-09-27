// Loki line patterns (from the pattern ingester, Loki 3.x): turning a pattern
// into an RE2 line regex for drop / sample rules, splitting it for display,
// and estimating what a rule on it would save. Pure; lib/sources/loki.ts
// fetches the patterns.

import type { LineFilter } from "@/lib/core/logs/types"
import { lineRegexProblem } from "@/lib/core/logs/selector"

/** What Loki writes where a pattern's lines differ. */
export const PATTERN_PLACEHOLDER = "<_>"

/** Longest regex Cardinal builds; line regexes are capped at 500 characters. */
export const MAX_PATTERN_REGEX = 480

/** Fewer literal (non-space) characters than this and a pattern matches nearly anything. */
export const MIN_LITERAL_CHARS = 4

/** Pattern ingesters keep about 3 hours of patterns (pattern-ingester retain_for). */
export const PATTERN_RETENTION_SECONDS = 3 * 3600

// RE2's \s is ASCII only ([\t\n\f\r ]), so only those count as spaces. Anything
// else (NBSP, \v, unicode spaces) stays a literal.
const SPACE = /[ \t\n\r\f]/

export interface PatternSegment {
  text: string
  placeholder: boolean
}

/** Literal text and `<_>` placeholders in order; adjacent placeholders merge into one. */
export function patternSegments(pattern: string): PatternSegment[] {
  const segments: PatternSegment[] = []
  let rest = pattern
  while (rest.length) {
    const index = rest.indexOf(PATTERN_PLACEHOLDER)
    if (index === -1) {
      segments.push({ text: rest, placeholder: false })
      break
    }
    if (index > 0) segments.push({ text: rest.slice(0, index), placeholder: false })
    const last = segments.at(-1)
    if (last?.placeholder) last.text += PATTERN_PLACEHOLDER
    else segments.push({ text: PATTERN_PLACEHOLDER, placeholder: true })
    rest = rest.slice(index + PATTERN_PLACEHOLDER.length)
  }
  return segments
}

function escapeChar(char: string) {
  const code = char.codePointAt(0)!
  // Control characters (ANSI colour codes, \v) as \xHH: valid in RE2 and JS, and line regexes refuse raw ones.
  if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

type Token = { kind: "lit"; text: string } | { kind: "space" } | { kind: "any" }

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = []
  const push = (token: Token) => {
    const last = tokens.at(-1)
    // `<_>` next to `<_>` is one gap; a run of spaces is one \s+.
    if (last && last.kind === token.kind && token.kind !== "lit") return
    tokens.push(token)
  }
  for (const segment of patternSegments(pattern)) {
    if (segment.placeholder) {
      push({ kind: "any" })
      continue
    }
    for (const char of segment.text) {
      if (SPACE.test(char)) push({ kind: "space" })
      else push({ kind: "lit", text: escapeChar(char) })
    }
  }
  return tokens
}

export interface PatternRegex {
  /** RE2 line regex for `|~` filters, Alloy stage.drop and Promtail drop. */
  regex: string
  /** Literal characters the regex pins (spaces not counted). */
  literalChars: number
  /** Too few literals: it would match almost every line, so don't drop with it. */
  broad: boolean
  /** The pattern was too long; the regex matches its start only. */
  truncated: boolean
}

/**
 * The line regex for a pattern: literal text escaped, `<_>` as `.*?`, runs of
 * spaces as `\s+` (Loki re-joins tokens with single spaces), anchored at both
 * ends. A leading or trailing `<_>` drops that anchor instead of spelling
 * `^.*?`, and trailing whitespace (patterns keep the line's `\n`) becomes
 * `\s*$`. Past `maxLength` the regex keeps the pattern's start and matches it
 * as a prefix.
 */
export function patternToRegex(pattern: string, { maxLength = MAX_PATTERN_REGEX }: { maxLength?: number } = {}): PatternRegex {
  const tokens = tokenize(pattern)
  while (tokens[0]?.kind === "space" && tokens[1]?.kind === "any") tokens.shift()
  while (tokens.at(-1)?.kind === "space" && tokens.at(-2)?.kind === "any") tokens.pop()

  const leadingAny = tokens[0]?.kind === "any"
  const trailingAny = tokens.at(-1)?.kind === "any"
  const trailingSpace = tokens.at(-1)?.kind === "space"
  const body = tokens.slice(leadingAny ? 1 : 0, trailingAny || trailingSpace ? -1 : undefined)
  if (tokens.length && leadingAny && body.length === 0 && tokens.length === 1) {
    return { regex: ".*", literalChars: 0, broad: true, truncated: false }
  }

  const head = leadingAny ? "" : "^"
  const tail = trailingAny ? "" : trailingSpace ? "\\s*$" : "$"
  const text = (token: Token) => (token.kind === "lit" ? token.text : token.kind === "space" ? "\\s+" : ".*?")

  let regex = head
  let literalChars = 0
  let truncated = false
  for (const [index, token] of body.entries()) {
    const piece = text(token)
    const isLast = index === body.length - 1
    if (regex.length + piece.length + (isLast ? tail.length : 0) > maxLength) {
      truncated = true
      break
    }
    regex += piece
    if (token.kind === "lit") literalChars += 1
  }
  if (truncated) {
    // A prefix match: no end anchor, and no dangling gap or space at the cut.
    regex = regex.replace(/(?:\\s\+|\.\*\?)+$/, "")
  } else {
    regex += tail
  }
  if (regex === "" || regex === "^") regex = ".*"
  return { regex, literalChars, broad: literalChars < MIN_LITERAL_CHARS, truncated }
}

/** The line filter for a rule on this pattern, or null when the pattern is too broad or the regex is unusable. */
export function patternLineFilter(pattern: string): LineFilter | null {
  const { regex, broad } = patternToRegex(pattern)
  if (broad || lineRegexProblem(regex)) return null
  return { regex }
}

/**
 * Tests a line the way Loki's `|~` would (JS and RE2 agree on everything
 * patternToRegex emits). For tests and previews.
 */
export function patternMatchesLine(pattern: string, line: string) {
  return new RegExp(patternToRegex(pattern).regex).test(line)
}

/** A short, readable form for toasts and rationales: whitespace collapsed, clipped. */
export function patternPreview(pattern: string, max = 80) {
  const flat = pattern.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * RE2 for an Adaptive Logs recommendation's tokens (`<*>` is a variable part):
 * literals escaped, wildcards as `.*?`, unanchored, since Adaptive Logs
 * tokenizes lines its own way and its patterns aren't whole-line templates.
 */
export function tokensToRegex(tokens: string[]) {
  const parts = tokens.map((token) => (token === "<*>" ? ".*?" : Array.from(token, escapeChar).join("")))
  // Collapse runs of wildcards, trim leading and trailing ones (the match is unanchored).
  return parts
    .join("")
    .replace(/(\.\*\?)+/g, ".*?")
    .replace(/^\.\*\?|\.\*\?$/g, "")
}

export interface PatternInput {
  pattern: string
  level?: string
  count: number
  samples: Array<{ t: number; count: number }>
}

export interface PatternRow extends PatternInput {
  /** Share of the lines the pattern ingester saw (all patterns' counts), 0–1. */
  share: number
  /** Estimated share of all the service's lines, 0–1: `share`, or count / lines when coverage is low. */
  lineShare: number
  /** Estimated bytes per day: lineShare × the service's bytes per day. */
  bytesPerDay: number | null
}

/** Below this coverage the ingester saw too few lines for its mix to stand for the service. */
export const MIN_PATTERN_COVERAGE = 0.1

export interface PatternContext {
  /** Lines the service logged over the same window (index/stats entries), when known. */
  lines?: number | null
  /** The service's bytes per day, when known. */
  bytesPerDay?: number | null
}

/** Share of the service's lines the patterns account for, 0–1; null without a line count. */
export function patternCoverage(patterns: Array<Pick<PatternInput, "count">>, lines: number | null | undefined): number | null {
  if (!lines || !(lines > 0)) return null
  const seen = patterns.reduce((sum, item) => sum + Math.max(0, item.count), 0)
  return Math.min(1, seen / lines)
}

/**
 * Patterns ranked by lines, with their share of the lines the ingester saw
 * (adding up to 100%) and estimated bytes per day. When the patterns cover
 * enough of the service's lines their mix stands for the service; otherwise
 * each pattern's share is its count over all lines (conservative). Byte
 * estimates assume the pattern's lines are as long as the service's average.
 */
export function rankPatterns(patterns: PatternInput[], context: PatternContext = {}): PatternRow[] {
  const total = patterns.reduce((sum, item) => sum + Math.max(0, item.count), 0)
  const coverage = patternCoverage(patterns, context.lines)
  const lowCoverage = coverage !== null && coverage < MIN_PATTERN_COVERAGE
  const daily = context.bytesPerDay ?? null
  return patterns
    .map((item) => {
      const count = Math.max(0, item.count)
      const share = total > 0 ? count / total : 0
      const lineShare = lowCoverage ? Math.min(1, count / context.lines!) : share
      return { ...item, share, lineShare, bytesPerDay: daily === null ? null : lineShare * daily }
    })
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
}

/** Bytes a rule on a pattern saves: its bytes × the share not kept (keep 0 = drop). */
export function patternSavings(bytes: number, keep: number) {
  const rate = Math.min(1, Math.max(0, keep))
  return Math.max(0, bytes) * (1 - rate)
}

/** Seconds the samples span (first to last sample plus one step), or null with fewer than two samples. */
export function patternSpanSeconds(patterns: Array<Pick<PatternInput, "samples">>): number | null {
  let first = Infinity
  let last = -Infinity
  let step = Infinity
  for (const item of patterns) {
    for (let i = 0; i < item.samples.length; i++) {
      const t = item.samples[i].t
      first = Math.min(first, t)
      last = Math.max(last, t)
      if (i > 0) step = Math.min(step, t - item.samples[i - 1].t)
    }
  }
  if (!Number.isFinite(first) || last <= first) return null
  return Math.round((last - first + (Number.isFinite(step) ? step : 0)) / 1000)
}

/** Samples bucketed onto a shared, evenly spaced time axis for a sparkline (missing buckets are 0). */
export function sparklineValues(samples: Array<{ t: number; count: number }>, axis: number[]): number[] {
  const byT = new Map(samples.map((sample) => [sample.t, sample.count]))
  return axis.map((t) => byT.get(t) ?? 0)
}

/** Every sample timestamp across patterns, sorted. */
export function sampleAxis(patterns: Array<Pick<PatternInput, "samples">>): number[] {
  const set = new Set<number>()
  for (const item of patterns) for (const sample of item.samples) set.add(sample.t)
  return Array.from(set).sort((a, b) => a - b)
}
