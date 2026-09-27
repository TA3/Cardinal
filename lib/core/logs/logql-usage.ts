import { formatAge, STALE_SCAN_MS } from "@/lib/core/grafana-usage"
import { parseLogSelector, selectorContains, selectorsDisjoint } from "@/lib/core/logs/selector"
import type { LogRule, LogRuleKind, StreamSelector } from "@/lib/core/logs/types"
import type { EvidenceSummary } from "@/lib/core/usage-gate"

// Where a log rule's streams are read: Loki alerting and recording rules (the
// ruler API) and LogQL panel queries in Grafana dashboards. The logs twin of
// lib/core/usage-gate.ts, and the one evidence model for the rule toggle's
// gate, the Rules page's Used column, Accept all and the agent's tools. Pure:
// selectors are pulled out of LogQL text and compared with the rule's
// selector; features/rules/log-usage.ts fetches.

/** A LogQL query that reads logs: a Loki rule, or a dashboard panel target. */
export interface LogQueryRef {
  kind: "alerting" | "recording" | "panel" | "variable"
  name: string
  /** Rule group (rules) or dashboard title (panels). */
  where: string
  url?: string
  expr: string
  selectors: StreamSelector[]
}

const IDENT = /[A-Za-z0-9_:]/
// Grafana template variables: $var, ${var}, ${var:fmt}, [[var]].
const VARIABLE = /\$\{?[A-Za-z_]\w*(?::[^}]*)?\}?|\[\[[A-Za-z_]\w*\]\]/
const MATCHER = /([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g

/** Index just past the string literal starting at `start` ("…" or `…`). */
function skipString(text: string, start: number) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length && text[i] !== quote) i += quote === '"' && text[i] === "\\" ? 2 : 1
  return i + 1
}

/** A templated matcher (`app="$app"`) could match anything: it becomes `app=~".+"` (or `.*` when negated). */
function untemplate(selectorText: string) {
  return selectorText.replace(MATCHER, (whole, label: string, op: string, value: string) => {
    if (!VARIABLE.test(value)) return whole
    return op === "=" || op === "=~" ? `${label}=~".+"` : `${label}=~".*"`
  })
}

/**
 * Every stream selector in a LogQL expression, e.g. both sides of a ratio.
 * Braces inside strings (line_format templates) and PromQL metric selectors
 * (`up{job="x"}`, where a name precedes the brace) are skipped, and Grafana
 * variables are treated as "any value".
 */
export function extractLogSelectors(expr: string): StreamSelector[] {
  const found: StreamSelector[] = []
  let i = 0
  while (i < expr.length) {
    const char = expr[i]
    if (char === '"' || char === "`") {
      i = skipString(expr, i)
      continue
    }
    if (char !== "{") {
      i += 1
      continue
    }
    let before = i - 1
    while (before >= 0 && /\s/.test(expr[before])) before -= 1
    if (expr[i + 1] === "{" || (before >= 0 && (IDENT.test(expr[before]) || expr[before] === "}"))) {
      i += 1
      continue
    }
    let end = i + 1
    while (end < expr.length && expr[end] !== "}") end = expr[end] === '"' || expr[end] === "`" ? skipString(expr, end) : end + 1
    if (end >= expr.length) break
    try {
      const { selector } = parseLogSelector(untemplate(expr.slice(i, end + 1)))
      if (selector.matchers.length) found.push(selector)
    } catch {
      // Not a selector (e.g. a JSON literal): skip it.
    }
    i = end + 1
  }
  return found
}

/** The expression without its string literals, for spotting label names. */
function withoutStrings(expr: string) {
  let out = ""
  let i = 0
  while (i < expr.length) {
    if (expr[i] === '"' || expr[i] === "`") {
      i = skipString(expr, i)
      out += '""'
    } else {
      out += expr[i]
      i += 1
    }
  }
  return out
}

/** True when the expression names `label` anywhere outside strings: a matcher, `by (…)`, a label filter. */
export function exprUsesLabel(expr: string, label: string) {
  return new RegExp(`(^|[^A-Za-z0-9_.])${label}(?![A-Za-z0-9_])`).test(withoutStrings(expr))
}

// ---- Loki rules ----

interface PromRulesBody {
  data?: { groups?: Array<{ name?: string; file?: string; rules?: Array<{ name?: string; query?: string; type?: string }> }> }
}

/** Rules from the Prometheus-style `/prometheus/api/v1/rules` JSON Loki serves. */
export function parseLokiRulesJson(body: unknown): LogQueryRef[] {
  const groups = (body as PromRulesBody | null)?.data?.groups
  if (!Array.isArray(groups)) throw new Error("The rules API answered without rule groups.")
  const refs: LogQueryRef[] = []
  for (const group of groups) {
    for (const rule of group.rules ?? []) {
      if (typeof rule?.query !== "string") continue
      refs.push({
        kind: rule.type === "alerting" ? "alerting" : "recording",
        name: rule.name ?? "(unnamed)",
        where: [group.file, group.name].filter(Boolean).join(" › "),
        expr: rule.query,
        selectors: extractLogSelectors(rule.query),
      })
    }
  }
  return refs
}

function unquoteYaml(value: string) {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * Rules from the YAML `/loki/api/v1/rules` returns (namespace → groups →
 * rules). A small line reader: enough for the ruler's own output (plain,
 * quoted and block-scalar `expr`), not a general YAML parser.
 */
export function parseLokiRulesYaml(text: string): LogQueryRef[] {
  const refs: LogQueryRef[] = []
  const lines = text.split(/\r?\n/)
  let namespace = ""
  let group = ""
  let current: { kind: LogQueryRef["kind"]; name: string; expr?: string } | null = null
  const flush = () => {
    if (current?.expr) {
      refs.push({ kind: current.kind, name: current.name, where: [namespace, group].filter(Boolean).join(" › "), expr: current.expr, selectors: extractLogSelectors(current.expr) })
    }
    current = null
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const indent = indentOf(line)
    const body = line.trim().replace(/^-\s+/, "")
    if (indent === 0 && /^[^\s-][^:]*:\s*$/.test(line)) {
      flush()
      namespace = unquoteYaml(line.replace(/:\s*$/, ""))
      continue
    }
    const pair = /^([A-Za-z_]+):\s?(.*)$/.exec(body)
    if (!pair) continue
    const [, key, rawValue] = pair
    if (key === "name" && line.trim().startsWith("-")) {
      flush()
      group = unquoteYaml(rawValue)
    } else if (key === "alert" || key === "record") {
      flush()
      current = { kind: key === "alert" ? "alerting" : "recording", name: unquoteYaml(rawValue) }
    } else if (key === "expr" && current) {
      const value = rawValue.trim()
      if (/^[|>][+-]?\d*$/.test(value)) {
        const block: string[] = []
        const keyIndent = indent + (line.trim().startsWith("-") ? 2 : 0)
        while (index + 1 < lines.length && (!lines[index + 1].trim() || indentOf(lines[index + 1]) > keyIndent)) {
          index += 1
          block.push(lines[index].trim())
        }
        current.expr = block.join(value.startsWith(">") ? " " : "\n").trim()
      } else {
        current.expr = unquoteYaml(value)
      }
    }
  }
  flush()
  return refs
}

// ---- matching ----

export interface LogRuleTarget {
  kind: LogRuleKind
  /** Empty: every stream. */
  selector: StreamSelector
  label?: string
}

/**
 * How a query relates to a rule's streams:
 * - "reads": it selects some of them by the same labels the rule does (or the
 *   rule covers every stream), and for label rules it uses the label;
 * - "maybe": it selects by other labels, so it may include them;
 * - null: it can't read them (disjoint selectors, or it doesn't use the label).
 */
export function matchLogQuery(target: LogRuleTarget, query: Pick<LogQueryRef, "expr" | "selectors">): "reads" | "maybe" | null {
  if (!query.selectors.length) return null
  const label = target.label
  if (label !== undefined) {
    const inMatchers = query.selectors.some((selector) => selector.matchers.some((matcher) => matcher.label === label))
    // Structured metadata still works in pipelines and `by (…)`; only selector matchers break.
    const uses = target.kind === "label_to_metadata" ? inMatchers : inMatchers || exprUsesLabel(query.expr, label)
    if (!uses) return null
  }
  let best: "reads" | "maybe" | null = null
  for (const selector of query.selectors) {
    if (target.selector.matchers.length === 0) return "reads"
    if (selectorsDisjoint(target.selector, selector)) continue
    // A match-anything matcher (a templated `$service`) doesn't pick these streams out.
    const sameLabels = target.selector.matchers.every((matcher) =>
      selector.matchers.some((other) => other.label === matcher.label && !(other.op === "=~" && (other.value === ".+" || other.value === ".*")))
    )
    if (sameLabels || selectorContains(target.selector, selector)) return "reads"
    best = "maybe"
  }
  return best
}

/** What Cardinal knows about where logs are read, for any number of rules. */
export interface LogUsageEvidence {
  /** Loki rules; null when the rules API couldn't be read. */
  rules: LogQueryRef[] | null
  rulesError?: string
  /** The last LogQL dashboard scan; null when there is none. */
  dashboards: { queries: LogQueryRef[]; host: string; scannedAt: string; dashboardsScanned: number } | null
}

export interface LogUsageInput extends LogUsageEvidence {
  target: LogRuleTarget
  now?: number
}

/** The usage target of a rule; null for kinds that remove nothing anyone reads (keep). */
export function logRuleTarget(rule: Pick<LogRule, "kind" | "selector"> & { label?: string }): LogRuleTarget | null {
  if (rule.kind === "keep") return null
  return { kind: rule.kind, selector: rule.selector, ...(rule.kind === "drop_label" || rule.kind === "label_to_metadata" ? { label: rule.label } : {}) }
}

export interface LogUsageMatches {
  reads: LogQueryRef[]
  maybe: LogQueryRef[]
}

export function partitionLogUsage(target: LogRuleTarget, queries: LogQueryRef[]): LogUsageMatches {
  const reads: LogQueryRef[] = []
  const maybe: LogQueryRef[] = []
  for (const query of queries) {
    const match = matchLogQuery(target, query)
    if (match === "reads") reads.push(query)
    else if (match === "maybe") maybe.push(query)
  }
  return { reads, maybe }
}

const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`

function names(refs: LogQueryRef[], max = 3) {
  const unique = Array.from(new Set(refs.map((ref) => ref.name)))
  return `${unique.slice(0, max).join(", ")}${unique.length > max ? ", …" : ""}`
}

/** Labels the "maybe" queries select by, for "select by other labels (app, kind)". */
function otherLabels(target: LogRuleTarget, refs: LogQueryRef[]) {
  const own = new Set(target.selector.matchers.map((matcher) => matcher.label))
  const labels = new Set<string>()
  for (const ref of refs) for (const selector of ref.selectors) for (const matcher of selector.matchers) if (!own.has(matcher.label)) labels.add(matcher.label)
  const list = Array.from(labels).sort()
  return `${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""}`
}

/** What the rule would touch, as the gate's evidence list (same shape as the metrics gate). */
export function summarizeLogUsage(input: LogUsageInput): EvidenceSummary {
  const { target } = input
  const found: string[] = []
  const unchecked: string[] = []
  const clear: string[] = []
  const checked: string[] = []
  const badge: string[] = []
  const how = target.label !== undefined ? `use ${target.label} on these streams` : "read these streams"

  if (target.kind === "retention") {
    // Rules evaluate recent lines; retention only removes old ones.
    clear.push("Loki rules read recent lines, which retention doesn't remove.")
  } else if (input.rules === null) {
    unchecked.push(`Loki alerting and recording rules couldn't be read${input.rulesError ? ` (${input.rulesError})` : ""}.`)
  } else {
    const { reads, maybe } = partitionLogUsage(target, input.rules)
    if (reads.length) {
      const alerts = reads.filter((ref) => ref.kind === "alerting").length
      const recordings = reads.length - alerts
      const parts = [alerts ? plural(alerts, "Loki alerting rule") : null, recordings ? plural(recordings, "Loki recording rule") : null].filter(Boolean)
      found.push(`${parts.join(" and ")} ${reads.length === 1 ? "reads" : "read"} these streams${target.label !== undefined ? ` by ${target.label}` : ""}: ${names(reads)}.`)
      if (alerts) badge.push(plural(alerts, "alert"))
      if (recordings) badge.push(plural(recordings, "recording"))
    } else {
      clear.push(`No Loki alerting or recording rule ${how.replace("use", "uses").replace("read", "reads")}.`)
    }
    if (maybe.length) {
      unchecked.push(`${plural(maybe.length, "Loki rule")} ${maybe.length === 1 ? "selects" : "select"} streams by other labels (${otherLabels(target, maybe)}) and may include these.`)
    }
    checked.push(`Checked ${plural(input.rules.length, "Loki rule")}.`)
  }

  const scan = input.dashboards
  if (!scan) {
    unchecked.push("Grafana dashboards weren't checked for LogQL: run a LogQL scan (connect Grafana in Settings first).")
  } else {
    const { reads, maybe } = partitionLogUsage(target, scan.queries)
    if (reads.length) {
      const dashboards = new Set(reads.map((ref) => ref.where)).size
      found.push(`${plural(reads.length, "dashboard panel")} in ${plural(dashboards, "dashboard")} ${reads.length === 1 ? "reads" : "read"} these streams${target.label !== undefined ? ` by ${target.label}` : ""}: ${names(reads)}.`)
      badge.push(plural(dashboards, "dashboard"))
    } else {
      clear.push(`No LogQL dashboard panel ${how.replace("use", "uses").replace("read", "reads")}.`)
    }
    if (maybe.length) {
      unchecked.push(`${plural(maybe.length, "panel")} ${maybe.length === 1 ? "selects" : "select"} streams by other labels (${otherLabels(target, maybe)}) and may include these.`)
    }
    const scanAge = (input.now ?? Date.now()) - new Date(scan.scannedAt).getTime()
    checked.push(`Scanned ${plural(scan.dashboardsScanned, "dashboard")} on ${scan.host} for LogQL, ${formatAge(scanAge)}.`)
    if (scanAge > STALE_SCAN_MS) unchecked.push(`The LogQL scan is ${formatAge(scanAge).replace(" ago", "")} old; re-scan to see current dashboards.`)
  }
  unchecked.push("Grafana-managed alert rules and ad-hoc Explore queries weren't checked.")

  return { used: found.length > 0, found, unchecked, clear, checked, badge: badge.length ? badge.join(" · ") : null }
}

/** The summary for one rule; null for keep rules (they remove nothing). */
export function summarizeLogRule(rule: Pick<LogRule, "kind" | "selector"> & { label?: string }, evidence: LogUsageEvidence, now?: number): EvidenceSummary | null {
  const target = logRuleTarget(rule)
  return target ? summarizeLogUsage({ ...evidence, target, now }) : null
}

// ---- dashboards ----

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

/** LogQL-only signs: pipes, line filters, log range functions. */
function looksLikeLogQL(expr: string) {
  return (
    /\}\s*(\|[=~]?|!=|!~)/.test(expr) ||
    /\|\s*(json|logfmt|pattern|regexp|line_format|label_format|unwrap|unpack|decolorize|drop|keep)\b/.test(expr) ||
    /\b(count_over_time|bytes_over_time|bytes_rate|absent_over_time)\s*\(/.test(expr)
  )
}

/** "loki", "prometheus", or null when the datasource reference doesn't say (a variable, a bare uid). */
function datasourceType(datasource: unknown, variables: Map<string, string>): string | null {
  if (typeof datasource === "string") {
    const variable = /^\$\{?([A-Za-z0-9_]+)/.exec(datasource)?.[1]
    if (variable) return variables.get(variable) ?? null
    return /loki/i.test(datasource) ? "loki" : null
  }
  if (isObject(datasource)) {
    const type = asString(datasource.type)
    if (type && !type.startsWith("$")) return type
    const uid = asString(datasource.uid)
    const variable = uid ? /^\$\{?([A-Za-z0-9_]+)/.exec(uid)?.[1] : undefined
    if (variable) return variables.get(variable) ?? null
  }
  return null
}

function* panelsOf(list: unknown): Generator<Json> {
  for (const panel of asArray(list)) {
    if (!isObject(panel)) continue
    yield panel
    if (Array.isArray(panel.panels)) yield* panelsOf(panel.panels)
  }
}

/**
 * LogQL panel queries and query variables of one dashboard JSON (rows and
 * collapsed rows included). A target counts when its datasource is Loki, or
 * when the datasource is unknown and the query reads like LogQL.
 */
export function logQueriesOfDashboard(dashboard: unknown, ref: { title: string; url: string }): LogQueryRef[] {
  if (!isObject(dashboard)) return []
  const variables = new Map<string, string>()
  const templating = isObject(dashboard.templating) ? asArray(dashboard.templating.list) : []
  for (const variable of templating) {
    if (!isObject(variable)) continue
    const name = asString(variable.name)
    if (name && variable.type === "datasource") {
      const query = asString(variable.query)
      if (query) variables.set(name, query)
    }
  }
  const refs: LogQueryRef[] = []
  const add = (kind: LogQueryRef["kind"], name: string, url: string, expr: string | undefined, typed: string | null) => {
    if (!expr?.trim()) return
    if (typed !== null && typed !== "loki") return
    if (typed === null && !looksLikeLogQL(expr)) return
    const selectors = extractLogSelectors(expr)
    if (selectors.length) refs.push({ kind, name, where: ref.title, url, expr: expr.trim().slice(0, 500), selectors })
  }
  for (const panel of panelsOf(dashboard.panels)) {
    const panelType = datasourceType(panel.datasource, variables)
    const id = typeof panel.id === "number" ? panel.id : undefined
    const url = id === undefined ? ref.url : `${ref.url}${ref.url.includes("?") ? "&" : "?"}viewPanel=${id}`
    const title = asString(panel.title) || "Untitled panel"
    for (const target of asArray(panel.targets)) {
      if (!isObject(target)) continue
      const own = datasourceType(target.datasource, variables)
      add("panel", title, url, asString(target.expr), own ?? panelType)
    }
  }
  for (const variable of templating) {
    if (!isObject(variable) || variable.type !== "query") continue
    const query = isObject(variable.query) ? asString(variable.query.query) ?? asString(variable.query.expr) : asString(variable.query)
    add("variable", `$${asString(variable.name) ?? "variable"}`, ref.url, query, datasourceType(variable.datasource, variables))
  }
  return refs
}
