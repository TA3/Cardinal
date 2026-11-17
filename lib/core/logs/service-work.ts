import { patternLineFilter, type PatternRow } from "@/lib/core/logs/patterns"
import { selectorKey } from "@/lib/core/logs/selector"
import type { LogRule, StreamSelector } from "@/lib/core/logs/types"

// Going through a service by hand, like a scrape job on the metrics side:
// every pattern Loki found in its lines, with what the plan does to it
// (dropped, sampled, protected), what that saves, and whether it is done.
// Only rules on exactly this service's selector count here.

export type PatternWorkState = "open" | "kept" | "dropped" | "sampled" | "protected"

export interface PatternWork {
  pattern: string
  level?: string
  lineShare: number
  bytesPerDay: number | null
  /** The line filter for the pattern; null when it is nearly all placeholders (no rule can single it out). */
  regex: string | null
  state: PatternWorkState
  /** The rule that decides the state, when one does. */
  rule?: LogRule
  savedBytesPerDay: number
}

export interface ServiceWork {
  patterns: PatternWork[]
  /** Patterns cut, protected or kept on purpose. */
  done: number
  /** Bytes per day the service's rules save (whole-service rules included). */
  savedBytesPerDay: number
  /** A rule on every line of the service (drop or sample), which decides every pattern. */
  serviceRule?: LogRule
}

/** Key under which "keep as is" marks for a service's patterns are stored (next to the metrics jobs' marks). */
export function serviceKeptKey(by: string, group: string) {
  return `logs:${by}=${group}`
}

function levelMatches(rule: LogRule, level: string | undefined) {
  return rule.kind === "drop_lines" && Boolean(level) && (rule.line.levels ?? []).some((item) => item.toLowerCase() === level!.toLowerCase())
}

export function buildServiceWork({
  selector,
  patterns,
  rules,
  kept,
  bytesPerDay,
}: {
  selector: StreamSelector
  patterns: readonly Pick<PatternRow, "pattern" | "level" | "lineShare" | "bytesPerDay">[]
  rules: readonly LogRule[]
  kept: readonly string[]
  /** The service's bytes per day, for rules on every line. */
  bytesPerDay: number | null
}): ServiceWork {
  const key = selectorKey(selector)
  const here = rules.filter((rule) => rule.status === "active" && selectorKey(rule.selector) === key)
  const serviceRule =
    here.find((rule) => rule.kind === "drop_streams") ?? here.find((rule) => (rule.kind === "sample" || rule.kind === "keep") && !rule.line)
  const keptSet = new Set(kept)
  let done = 0
  let patternSaved = 0

  const rows = patterns.map((row): PatternWork => {
    const regex = patternLineFilter(row.pattern)?.regex ?? null
    const bytes = row.bytesPerDay ?? 0
    const byLine = (kind: LogRule["kind"]) =>
      regex === null ? undefined : here.find((rule) => rule.kind === kind && "line" in rule && rule.line?.regex === regex)
    let state: PatternWorkState = "open"
    let rule: LogRule | undefined
    let saved = 0
    if (serviceRule) {
      rule = serviceRule
      state = serviceRule.kind === "drop_streams" ? "dropped" : serviceRule.kind === "keep" ? "protected" : "sampled"
      saved = serviceRule.kind === "drop_streams" ? bytes : serviceRule.kind === "sample" ? bytes * (1 - serviceRule.keep) : 0
    } else if ((rule = byLine("keep"))) {
      state = "protected"
    } else if ((rule = byLine("drop_lines") ?? here.find((item) => levelMatches(item, row.level)))) {
      state = "dropped"
      saved = bytes
    } else if ((rule = byLine("sample")) && rule.kind === "sample") {
      state = "sampled"
      saved = bytes * (1 - rule.keep)
    } else if (keptSet.has(row.pattern)) {
      rule = undefined
      state = "kept"
    } else {
      rule = undefined
    }
    if (state !== "open") done += 1
    patternSaved += saved
    return { pattern: row.pattern, level: row.level, lineShare: row.lineShare, bytesPerDay: row.bytesPerDay, regex, state, rule, savedBytesPerDay: saved }
  })

  // A rule on every line saves the service's whole volume (or its sampled share), not only what the patterns cover.
  const whole =
    serviceRule && bytesPerDay !== null
      ? serviceRule.kind === "drop_streams"
        ? bytesPerDay
        : serviceRule.kind === "sample"
          ? bytesPerDay * (1 - serviceRule.keep)
          : 0
      : null
  const savedBytesPerDay = whole ?? (bytesPerDay === null ? patternSaved : Math.min(bytesPerDay, patternSaved))
  return { patterns: rows, done, savedBytesPerDay, serviceRule }
}
