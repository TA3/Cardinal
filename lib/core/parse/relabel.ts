import { KEEP_BUCKET_MARK, KEEP_VALUE_MARK } from "@/lib/core/compile/plan"
import { isLabelName } from "@/lib/core/promql"
import { parseLiteralAlternation, regexProblem, splitJoinedRegex } from "@/lib/core/regex"
import { createRule, mergeRules, type Rule } from "@/lib/core/rules"

export interface RawRelabelRule {
  sourceLabels: string[]
  separator?: string
  action?: string
  regex?: string
  targetLabel?: string
  replacement?: string
  /** `job_name` of the scrape config the rule was found in; scopes unscoped rules. */
  scrapeJob?: string
}

export interface ImportResult {
  rules: Rule[]
  warnings: string[]
  ruleCount: number
}

function unscopedLiteral(regex: string) {
  const names = parseLiteralAlternation(regex)
  return names?.length === 1 ? names[0] : null
}

/** A single literal job; an empty part matches series without a job label. */
function jobLiteral(regex: string) {
  const trimmed = regex.replace(/^\^/, "").replace(/\$$/, "")
  if (trimmed === "" || trimmed === "()" || trimmed === "(?:)") return ""
  return unscopedLiteral(trimmed)
}

// Only a value condition matching any non-empty value clears the label as-is;
// anything narrower (e.g. `v1|v2`) is a different rule.
const ANY_VALUE = new Set([".+", ".*", "(.*)", "(.+)"])

/** Kept buckets (or a kept label value) seen in a mark step, waiting for the drop step that uses them. */
type PendingKeeps = Map<string, string[]>
const keepKey = (job: string | undefined, metric: string) => JSON.stringify([job ?? null, metric])
const valueKey = (job: string | undefined, metric: string, label: string) => JSON.stringify([job ?? null, metric, label])

/** Removes one wrapping group from the last part of a joined regex: `(re)` → `re`. */
function unwrapGroup(part: string) {
  const trimmed = part.trim()
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null
  const inner = trimmed.slice(1, -1).replace(/^\?:/, "")
  return regexProblem(inner) === null ? inner : null
}

/**
 * Splits `[job,] __name__, ...rest` source labels and their joined regex into
 * a literal job and metric plus the regex parts for the rest. Null when the
 * head isn't literal or the parts don't line up.
 */
function joinedHead(raw: RawRelabelRule, restCount: number) {
  const labels = raw.sourceLabels
  const scoped = labels[0] === "job" && labels[1] === "__name__" && labels.length === restCount + 2
  const unscoped = labels[0] === "__name__" && labels.length === restCount + 1
  if (!scoped && !unscoped) return null
  const parts = splitJoinedRegex(raw.regex ?? "(.*)", raw.separator ?? ";")
  if (parts?.length !== labels.length) return null
  const job = scoped ? jobLiteral(parts[0]) : undefined
  const metric = unscopedLiteral(parts[scoped ? 1 : 0])
  if (job === null || !metric) return null
  return { job: job ?? raw.scrapeJob, metric, rest: parts.slice(scoped ? 2 : 1), restLabels: labels.slice(scoped ? 2 : 1) }
}

function convert(raw: RawRelabelRule, pending: PendingKeeps): Rule[] | string {
  const action = (raw.action ?? "replace").trim().toLowerCase()
  const labels = raw.sourceLabels
  const regex = raw.regex ?? "(.*)"
  const separator = raw.separator ?? ";"
  const scope = (job: string | undefined | null) => {
    const resolved = job ?? raw.scrapeJob
    return resolved === undefined ? {} : { job: resolved }
  }

  // Keep one value of a label: mark it, drop the unmarked values, remove the mark.
  if (action === "labeldrop" && regex.trim() === KEEP_VALUE_MARK) return []
  if (action === "replace" && raw.targetLabel === KEEP_VALUE_MARK) {
    const head = joinedHead(raw, 1)
    const values = head ? parseLiteralAlternation(head.rest[0]) : null
    if (!head || values?.length !== 1) return "value mark is not one literal value"
    pending.set(valueKey(head.job, head.metric, head.restLabels[0]), values)
    return []
  }
  if (action === "drop" && labels[labels.length - 1] === KEEP_VALUE_MARK) {
    const head = joinedHead(raw, 2)
    const label = head?.restLabels[0]
    const value = head && label ? pending.get(valueKey(head.job, head.metric, label))?.[0] : undefined
    if (!head || !label || value === undefined) return "value drop without a matching value mark"
    return [
      createRule({
        kind: "drop_labels",
        selector: { metric: head.metric, ...scope(head.job) },
        labels: [label],
        onMerge: "keep_value",
        keepValues: { [label]: value },
        origin: "import",
      }),
    ]
  }

  // Keep-buckets: mark kept buckets, drop unmarked ones, remove the mark.
  if (action === "labeldrop" && regex.trim() === KEEP_BUCKET_MARK) return []
  if (action === "replace" && raw.targetLabel === KEEP_BUCKET_MARK) {
    const head = joinedHead(raw, 1)
    if (!head || head.restLabels[0] !== "le") return "bucket mark is not literal"
    const buckets = parseLiteralAlternation(head.rest[0])
    if (!buckets) return "bucket mark lists no literal le values"
    pending.set(keepKey(head.job, head.metric), buckets)
    return []
  }
  if (action === "drop" && labels[labels.length - 1] === KEEP_BUCKET_MARK) {
    const head = joinedHead(raw, 2)
    const buckets = head ? pending.get(keepKey(head.job, head.metric)) : undefined
    if (!head || !buckets) return "bucket drop without a matching bucket mark"
    return [createRule({ kind: "keep_buckets", selector: { metric: head.metric, ...scope(head.job) }, buckets, origin: "import" })]
  }

  if (action === "drop") {
    if (labels.length === 1 && labels[0] === "__name__") {
      const metrics = parseLiteralAlternation(regex)
      if (!metrics) return "drop regex is not a list of literal metric names"
      return metrics.map((metric) =>
        createRule({ kind: "drop_metric", selector: { metric, ...scope(undefined) }, origin: "import" })
      )
    }
    if (labels.length === 2 && labels[0] === "job" && labels[1] === "__name__") {
      const parts = splitJoinedRegex(regex, separator)
      if (parts?.length !== 2) return "job;metric drop regex is not literal"
      const job = jobLiteral(parts[0])
      const metrics = parseLiteralAlternation(parts[1])
      if (job === null || !metrics) return "job;metric drop regex is not literal"
      return metrics.map((metric) =>
        createRule({ kind: "drop_metric", selector: { metric, job }, origin: "import" })
      )
    }
    // Series drop: `[job,] __name__, label` with a literal head and a value pattern.
    const head = joinedHead(raw, 1)
    const label = head?.restLabels[0]
    if (head && label && label !== "job" && isLabelName(label)) {
      const pattern = unwrapGroup(head.rest[0]) ?? (regexProblem(head.rest[0]) === null ? head.rest[0] : null)
      if (pattern === null) return `drop on [${labels.join(", ")}] has an unsupported value pattern`
      return [
        createRule({ kind: "drop_series", selector: { metric: head.metric, ...scope(head.job) }, match: { label, regex: pattern }, origin: "import" }),
      ]
    }
    return `unsupported drop on [${labels.join(", ")}]`
  }

  if (action === "replace" && (raw.replacement ?? "$1") === "") {
    const scoped = labels.length === 3 && labels[0] === "job" && labels[1] === "__name__"
    const unscoped = labels.length === 2 && labels[0] === "__name__"
    if (!scoped && !unscoped) return "unsupported replace source_labels"

    const parts = splitJoinedRegex(regex, separator)
    if (parts?.length !== labels.length) return "replace regex is not literal"
    const job = scoped ? jobLiteral(parts[0]) : undefined
    const metric = unscopedLiteral(parts[scoped ? 1 : 0])
    const label = raw.targetLabel ?? labels[labels.length - 1]
    if (!metric || job === null) return "replace regex is not literal"
    if (!ANY_VALUE.has(parts[parts.length - 1].trim().replace(/\$$/, ""))) {
      return "replace only clears some values of the label (value condition is not .+, .* or (.*))"
    }
    if (label !== labels[labels.length - 1]) return "replace target differs from source label"

    return [
      createRule({
        kind: "drop_labels",
        selector: { metric, ...scope(job) },
        labels: [label],
        origin: "import",
      }),
    ]
  }

  return `unsupported action '${action}'`
}

export function rulesFromRelabel(raws: RawRelabelRule[]): ImportResult {
  const warnings: string[] = []
  let rules: Rule[] = []
  const pending: PendingKeeps = new Map()
  raws.forEach((raw, index) => {
    const out = convert(raw, pending)
    if (typeof out === "string") {
      warnings.push(`Rule ${index + 1}: ${out}`)
    } else {
      rules = mergeRules(rules, out).rules
    }
  })
  return { rules, warnings, ruleCount: raws.length }
}
