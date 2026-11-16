import { generalizePath } from "@/lib/core/id-like"
import { assertLabelName, quoteLabelValue } from "@/lib/core/promql"
import { escapeRegex, fullMatch, literalAlternation, regexProblem } from "@/lib/core/regex"

// Grouping label values: many values of one label become a few (`200|201|204`
// → `2xx`, `/api/users/123` → `/api/users/:id`). Series that end up with the
// same labels merge, so the merged samples have to be combined: summed,
// counted, maxed... That needs an aggregation (a recording rule on remote
// write), never a plain relabel, which would just make the series collide.

/** How the series merged into one group are combined. */
export type GroupAggregation = "sum" | "count" | "max" | "min" | "avg"
export const GROUP_AGGREGATIONS: readonly GroupAggregation[] = ["sum", "count", "max", "min", "avg"]

/** One output value and the input values it takes in: a regex (RE2, fully anchored). */
export interface ValueGroup {
  name: string
  regex: string
}

export interface Grouping {
  label: string
  /** Checked in order: a value goes to the first group that matches. */
  groups: ValueGroup[]
  /** When set, values no group matches become this value; otherwise they stay as they are. */
  rest?: string
  aggregation: GroupAggregation
}

export interface ValueCount {
  value: string
  seriesCount: number
}

/** Index of the group a value lands in: a group index, -1 for `rest`, null when it keeps its value. */
export function groupOf(value: string, groups: ValueGroup[], rest?: string): number | null {
  const index = groups.findIndex((group) => group.regex && !regexProblem(group.regex) && fullMatch(group.regex, value))
  if (index !== -1) return index
  // Series without the label keep not having it.
  return rest && value !== "" ? -1 : null
}

export interface GroupOutcome {
  /** The output value. */
  name: string
  /** Group index, -1 for `rest`, null for a value kept as it is. */
  group: number | null
  values: string[]
  seriesCount: number
}

/**
 * What the sampled values become: one row per output value, largest first.
 * Groups with the same name merge into one row (they are one value after all).
 */
export function groupOutcome(values: ValueCount[], groups: ValueGroup[], rest?: string): GroupOutcome[] {
  const rows = new Map<string, GroupOutcome>()
  for (const item of values) {
    const group = groupOf(item.value, groups, rest)
    const name = group === null ? item.value : group === -1 ? rest! : groups[group].name
    const row = rows.get(name) ?? { name, group, values: [], seriesCount: 0 }
    row.values.push(item.value)
    row.seriesCount += item.seriesCount
    if (row.group === null && group !== null) row.group = group
    rows.set(name, row)
  }
  return Array.from(rows.values()).sort((a, b) => b.seriesCount - a.seriesCount)
}

/** The first problem with a grouping, or null when it can be saved. */
export function groupingProblem(grouping: Pick<Grouping, "groups" | "rest">): string | null {
  if (grouping.groups.length === 0 && !grouping.rest) return "add a group"
  for (const [index, group] of grouping.groups.entries()) {
    const which = group.name ? `"${group.name}"` : `group ${index + 1}`
    if (!group.name.trim()) return `${which} needs a name`
    if (!group.regex) return `${which} matches nothing yet`
    const problem = regexProblem(group.regex)
    if (problem) return `${which}: ${problem}`
  }
  if (grouping.rest !== undefined && !grouping.rest.trim()) return "name the value for everything else"
  return null
}

/** Literal values a regex is an alternation of, or null when it is a real pattern. */
export function literalValues(regex: string): string[] | null {
  if (!regex) return []
  const parts: string[] = []
  let current = ""
  for (let i = 0; i < regex.length; i += 1) {
    const char = regex[i]
    if (char === "\\") {
      const next = regex[i + 1]
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null
      current += next
      i += 1
    } else if (char === "|") {
      parts.push(current)
      current = ""
    } else if (/[.*+?^${}()[\]]/.test(char)) {
      return null
    } else {
      current += char
    }
  }
  parts.push(current)
  return literalAlternation(parts) === regex ? parts : null
}

export function valuesRegex(values: string[]) {
  return literalAlternation(values)
}

/** Label used while grouping in PromQL; removed again by the aggregation. */
export const GROUP_TEMP_LABEL = "cardinal_group"

/** A label_replace replacement is expanded (`$1`); `$$` keeps a literal dollar. */
const replacement = (value: string) => quoteLabelValue(value.replace(/\$/g, "$$$$"))

/**
 * `sel` with the label's values rewritten by the grouping, still one series
 * per input series. The group name goes to a temporary label first, so each
 * group matches the original value: the rest fold is innermost, then groups
 * from last to first, so the first matching group is written last and wins.
 */
export function groupedSelector(sel: string, grouping: Pick<Grouping, "label" | "groups" | "rest">) {
  const label = quoteLabelValue(assertLabelName(grouping.label))
  const temp = quoteLabelValue(GROUP_TEMP_LABEL)
  let expr = sel
  if (grouping.rest) expr = `label_replace(${expr}, ${temp}, ${replacement(grouping.rest)}, ${label}, ".+")`
  for (const group of [...grouping.groups].reverse()) {
    expr = `label_replace(${expr}, ${temp}, ${replacement(group.name)}, ${label}, ${quoteLabelValue(`(?:${group.regex})`)})`
  }
  return `label_replace(${expr}, ${label}, "$1", ${temp}, "(.+)")`
}

/** The grouped series, merged with the chosen aggregation. */
export function groupedExpr(sel: string, grouping: Grouping) {
  return `${grouping.aggregation} without (${GROUP_TEMP_LABEL}) (${groupedSelector(sel, grouping)})`
}

/** Series left after grouping: the merged series count (exact). */
export function groupedSeriesCountQuery(sel: string, grouping: Pick<Grouping, "label" | "groups" | "rest">) {
  return `count(count without (${GROUP_TEMP_LABEL}) (${groupedSelector(sel, grouping)}))`
}

/** The recorded series name: `<metric>:<agg>_grouped_<label>`. */
export function groupingRecordName(metric: string, grouping: Pick<Grouping, "label" | "aggregation">) {
  return `${metric}:${grouping.aggregation}_grouped_${assertLabelName(grouping.label)}`
}

const COUNTER_SUFFIXES = ["_total", "_count", "_sum", "_bucket"]

/** True for counters and histogram parts: only a sum keeps them meaningful. */
export function isCounterLike(metric: string) {
  return COUNTER_SUFFIXES.some((suffix) => metric.endsWith(suffix))
}

export interface GroupSuggestion {
  id: string
  title: string
  description: string
  groups: ValueGroup[]
  rest?: string
}

const STATUS = /^[1-5]\d\d$/

/** `/api/users/[^/]+/orders` → `/api/users/:id/orders`. */
function readablePath(pattern: string) {
  return pattern
    .replace(/\[\^\/\]\+/g, ":id")
    .replace(/\.\*$/, "")
    .replace(/\\(.)/g, "$1")
}

// Kubernetes pod names: `<deployment>-<replicaset hash>-<pod hash>` or `<statefulset>-<n>`.
const POD = /^(.+?)-(?=[a-z0-9]*\d)[a-z0-9]{6,10}-[a-z0-9]{5}$|^(.+?)-[a-z0-9]{5}$/

function podPrefix(value: string) {
  const match = POD.exec(value)
  if (!match) return null
  const prefix = match[1] ?? match[2]
  return prefix && /\d/.test(value.slice(prefix.length)) ? prefix : null
}

/**
 * Ready-made groupings for common shapes of values: HTTP status codes by
 * class, paths with IDs by route, pod names by workload, and "the top few,
 * everything else as other". Judged from the sampled top values.
 */
export function suggestGroups(values: ValueCount[]): GroupSuggestion[] {
  const named = values.map((item) => item.value).filter((value) => value !== "")
  const suggestions: GroupSuggestion[] = []
  if (named.length < 2) return suggestions

  if (named.every((value) => STATUS.test(value))) {
    const classes = Array.from(new Set(named.map((value) => value[0]))).sort()
    if (classes.length < named.length) {
      suggestions.push({
        id: "status",
        title: "Status classes",
        description: `${named.length} codes into ${classes.map((digit) => `${digit}xx`).join(", ")}`,
        groups: classes.map((digit) => ({ name: `${digit}xx`, regex: `${digit}\\d\\d` })),
      })
    }
  }

  const routes = new Map<string, string[]>()
  for (const value of named) {
    const pattern = value.includes("/") ? generalizePath(value) : null
    if (pattern) routes.set(pattern, [...(routes.get(pattern) ?? []), value])
  }
  const routeGroups = Array.from(routes.entries()).sort((a, b) => b[1].length - a[1].length)
  if (routeGroups.length && routeGroups.reduce((sum, [, list]) => sum + list.length, 0) >= 2) {
    suggestions.push({
      id: "routes",
      title: "Routes",
      description: `IDs in paths become :id, ${routeGroups.length} route${routeGroups.length === 1 ? "" : "s"}`,
      groups: routeGroups.map(([pattern]) => ({ name: readablePath(pattern), regex: pattern })),
    })
  }

  const workloads = new Map<string, string[]>()
  for (const value of named) {
    const prefix = podPrefix(value)
    if (prefix) workloads.set(prefix, [...(workloads.get(prefix) ?? []), value])
  }
  const workloadGroups = Array.from(workloads.entries()).filter(([, list]) => list.length >= 2)
  if (workloadGroups.length) {
    suggestions.push({
      id: "workloads",
      title: "Workloads",
      description: `Pod hashes stripped, ${workloadGroups.length} workload${workloadGroups.length === 1 ? "" : "s"}`,
      groups: workloadGroups.map(([prefix]) => ({ name: prefix, regex: `${escapeRegex(prefix)}-[a-z0-9]{5,10}(?:-[a-z0-9]{5})?` })),
    })
  }

  const TOP = 5
  if (named.length > TOP * 2) {
    const top = [...values].filter((item) => item.value !== "").sort((a, b) => b.seriesCount - a.seriesCount).slice(0, TOP)
    suggestions.push({
      id: "top",
      title: `Top ${TOP} + other`,
      description: `Keep the ${TOP} largest values, fold the long tail into "other"`,
      groups: top.map((item) => ({ name: item.value, regex: escapeRegex(item.value) })),
      rest: "other",
    })
  }
  return suggestions
}
