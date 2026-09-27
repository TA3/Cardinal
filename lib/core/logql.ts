// Safe LogQL construction, the logs twin of promql.ts. Every stream selector
// Cardinal sends to Loki (from the UI or for an MCP agent) is built here from
// validated label names and escaped values, never from raw user LogQL.

import type { LabelMatcher, MatchOp, StreamSelector } from "@/lib/core/logs/types"
import { fullMatch, regexProblem } from "@/lib/core/regex"

/** Loki label names follow the Prometheus rules. */
export const LOKI_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export const MATCH_OPS: readonly MatchOp[] = ["=", "!=", "=~", "!~"]

export class InvalidLogQLError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidLogQLError"
  }
}

export function isLokiLabelName(value: string) {
  return value.length <= 200 && LOKI_LABEL_NAME.test(value)
}

export function assertLokiLabelName(value: string) {
  if (!isLokiLabelName(value)) throw new InvalidLogQLError(`Invalid label name: ${JSON.stringify(value)}`)
  return value
}

/** Escapes a value as a double-quoted LogQL (Go) string literal. */
export function quoteLogQLValue(value: string) {
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === "\\") out += "\\\\"
    else if (char === '"') out += '\\"'
    else if (char === "\n") out += "\\n"
    else if (char === "\r") out += "\\r"
    else if (char === "\t") out += "\\t"
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`
    else out += char
  }
  return `"${out}"`
}

function isRegexOp(op: MatchOp) {
  return op === "=~" || op === "!~"
}

/** Whether a matcher can match the empty string (Loki needs at least one that can't). */
export function matchesEmpty(matcher: LabelMatcher) {
  switch (matcher.op) {
    case "=":
      return matcher.value === ""
    case "!=":
      return matcher.value !== ""
    case "!~":
      return true
    case "=~":
      return fullMatch(matcher.value, "")
  }
}

export function matcherText({ label, op, value }: LabelMatcher) {
  if (!MATCH_OPS.includes(op)) throw new InvalidLogQLError(`Invalid match operator: ${JSON.stringify(op)}`)
  if (isRegexOp(op)) {
    const problem = regexProblem(value)
    if (problem) throw new InvalidLogQLError(`Invalid regex ${JSON.stringify(value)}: ${problem}`)
  }
  return `${assertLokiLabelName(label)}${op}${quoteLogQLValue(value)}`
}

/**
 * `{a="x", b=~"y|z"}`. Throws on an empty selector, bad names or regexes, and
 * when every matcher matches the empty string (Loki refuses those).
 */
export function streamSelector(selector: StreamSelector | LabelMatcher[]) {
  const matchers = Array.isArray(selector) ? selector : selector.matchers
  if (!matchers.length) throw new InvalidLogQLError("A stream selector needs at least one matcher.")
  const parts = matchers.map(matcherText)
  if (matchers.every(matchesEmpty)) {
    throw new InvalidLogQLError("A stream selector needs at least one matcher that doesn't match an empty value, e.g. label=~\".+\".")
  }
  return `{${parts.join(", ")}}`
}

/** Every stream that carries `label`: `{label=~".+"}`. */
export function anyValueSelector(label: string) {
  return streamSelector([{ label, op: "=~", value: ".+" }])
}

/** Equality matchers from a record, e.g. {service_name: "api"}. */
export function equalMatchers(values: Record<string, string>): LabelMatcher[] {
  return Object.entries(values).map(([label, value]) => ({ label, op: "=", value }))
}

/** A LogQL range duration, e.g. 3600 → "1h", 90 → "90s". */
export function logqlDuration(seconds: number) {
  const whole = Math.max(1, Math.floor(seconds))
  if (whole % 86400 === 0) return `${whole / 86400}d`
  if (whole % 3600 === 0) return `${whole / 3600}h`
  if (whole % 60 === 0) return `${whole / 60}m`
  return `${whole}s`
}

function byClause(labels: string[]) {
  return labels.length ? ` by (${labels.map(assertLokiLabelName).join(", ")})` : ""
}

export const logQueries = {
  /** Bytes per window, optionally split by labels. */
  bytesOverTime: (selector: StreamSelector | LabelMatcher[], windowSeconds: number, by: string[] = []) =>
    `sum${byClause(by)} (bytes_over_time(${streamSelector(selector)}[${logqlDuration(windowSeconds)}]))`,
  /** Lines per window, optionally split by labels. */
  countOverTime: (selector: StreamSelector | LabelMatcher[], windowSeconds: number, by: string[] = []) =>
    `sum${byClause(by)} (count_over_time(${streamSelector(selector)}[${logqlDuration(windowSeconds)}]))`,
}
