// Safe PromQL construction. Every query Cardinal sends (from the UI or on behalf
// of an MCP agent) is built here from validated identifiers, never from raw
// user-supplied PromQL.

import { literalAlternation, regexProblem } from "@/lib/core/regex"

export const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
export const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/
/** Job values Cardinal accepts from agents: any text without control characters ("" = no job). */
// eslint-disable-next-line no-control-regex
export const JOB_VALUE = /^[^\u0000-\u001f\u007f]*$/
export const MAX_NAME_LENGTH = 200

export class InvalidIdentifierError extends Error {
  constructor(kind: "metric" | "label", value: string) {
    super(`Invalid ${kind} name: ${JSON.stringify(value)}`)
    this.name = "InvalidIdentifierError"
  }
}

export function isMetricName(value: string) {
  return METRIC_NAME.test(value)
}

export function isLabelName(value: string) {
  return LABEL_NAME.test(value)
}

export function isJobValue(value: string) {
  return value.length <= MAX_NAME_LENGTH && JOB_VALUE.test(value)
}

export function assertMetricName(value: string) {
  if (!isMetricName(value)) throw new InvalidIdentifierError("metric", value)
  return value
}

export function assertLabelName(value: string) {
  if (!isLabelName(value)) throw new InvalidIdentifierError("label", value)
  return value
}

/** Escapes a value for use inside a double-quoted PromQL string literal. */
export function quoteLabelValue(value: string) {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`
}

export interface RegexMatcher {
  label: string
  op: "=~" | "!~"
  /** RE2, fully anchored by PromQL; checked with `isSafeRegex`. */
  value: string
}

export interface SeriesSelector {
  metric: string
  /** Equality matchers; values are escaped, names validated. */
  matchers?: Record<string, string>
  /** Regex matchers (for series and bucket rules); a label may appear more than once. */
  regexMatchers?: RegexMatcher[]
}

export class InvalidRegexError extends Error {
  constructor(value: string, reason: string) {
    super(`Invalid regex ${JSON.stringify(value)}: ${reason}`)
    this.name = "InvalidRegexError"
  }
}

export function assertRegex(value: string) {
  const problem = regexProblem(value)
  if (problem) throw new InvalidRegexError(value, problem)
  return value
}

export function selector({ metric, matchers = {}, regexMatchers = [] }: SeriesSelector) {
  const parts = [`__name__=${quoteLabelValue(assertMetricName(metric))}`]
  for (const [name, value] of Object.entries(matchers)) {
    parts.push(`${assertLabelName(name)}=${quoteLabelValue(value)}`)
  }
  for (const { label, op, value } of regexMatchers) {
    parts.push(`${assertLabelName(label)}${op === "!~" ? "!~" : "=~"}${quoteLabelValue(assertRegex(value))}`)
  }
  return `{${parts.join(",")}}`
}

const DEFAULT_TOP_LIMIT = 50

function topLimit(limit: number) {
  return Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : DEFAULT_TOP_LIMIT
}

function labelList(labels: string[]) {
  return labels.map(assertLabelName).join(", ")
}

export const queries = {
  /** Series count per (job, metric) across the whole instance. */
  seriesByJobAndMetric: () => 'count by (job, __name__) ({__name__=~".+"})',
  /** Series per metric for one job; `""` selects series without a job label. */
  seriesByMetricForJob: (job: string) => `count by (__name__) ({__name__=~".+",job=${quoteLabelValue(job)}})`,
  seriesCount: (sel: SeriesSelector) => `count(${selector(sel)})`,
  /** Number of distinct values `label` takes within the selector. */
  labelCardinality: (sel: SeriesSelector, label: string) =>
    `count(count by (${labelList([label])}) (${selector(sel)}))`,
  /** Series that would remain if `labels` were removed (exact merge count). */
  seriesWithoutLabels: (sel: SeriesSelector, labels: string[]) =>
    `count(count without (${labelList(labels)}) (${selector(sel)}))`,
  seriesByJob: (sel: SeriesSelector) => `count by (job) (${selector(sel)})`,
  /** Series a series-drop rule removes: those whose label matches the regex. */
  seriesMatching: (sel: SeriesSelector, label: string, regex: string) =>
    `count(${selector({ ...sel, regexMatchers: [...(sel.regexMatchers ?? []), { label, op: "=~", value: regex }] })})`,
  /** Bucket series a keep-buckets rule removes: a non-empty `le` outside the kept list. */
  bucketsOutside: (sel: SeriesSelector, kept: string[]) =>
    `count(${selector({
      ...sel,
      regexMatchers: [
        ...(sel.regexMatchers ?? []),
        { label: "le", op: "=~", value: ".+" },
        { label: "le", op: "!~", value: literalAlternation(kept) },
      ],
    })})`,
  topLabelValues: (sel: SeriesSelector, label: string, limit: number) =>
    `topk(${topLimit(limit)}, count by (${labelList([label])}) (${selector(sel)}))`,
}
