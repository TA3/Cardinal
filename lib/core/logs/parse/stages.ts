// Turns collector stages (read from Alloy or Promtail) back into log rules.
// Only stages that map cleanly become rules; everything else is a warning.

import type { Stage } from "@/lib/core/logs/compile/stages"
import { readKeepMarkers, type ParsedKeepMarker } from "@/lib/core/logs/keep"
import { createLogRule, mergeLogRules, type LogRuleInput } from "@/lib/core/logs/rules"
import {
  LEVEL_EXTRACT_REGEX,
  levelsFromLineRegex,
  levelsFromValueRegex,
  lineFilterFromParsed,
  normalizeLevels,
  parseLogSelector,
} from "@/lib/core/logs/selector"
import type { LineFilter, LogRule, StreamSelector } from "@/lib/core/logs/types"
import { escapeRegex } from "@/lib/core/regex"

export interface LogImportResult {
  rules: LogRule[]
  warnings: string[]
  /** Stages read, including ones that became no rule. */
  ruleCount: number
}

interface Scope {
  selector: StreamSelector
  line?: LineFilter
}

const LEVEL_SOURCES = new Set(["level", "lvl", "severity", "detected_level"])

function short(text: string) {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

function keepInput(keep: ParsedKeepMarker): LogRuleInput {
  return { kind: "keep", selector: keep.selector, ...(keep.line ? { line: keep.line } : {}), origin: "import", rationale: keep.rationale }
}

class Interpreter {
  inputs: LogRuleInput[] = []
  warnings: string[] = []
  count = 0
  /** Keep markers were found: negative line filters are their exclusions, not new keeps. */
  keepsFromMarkers = false

  add(input: LogRuleInput) {
    this.inputs.push(input)
  }

  run(stages: Stage[], scope: Scope) {
    const metadataLabels = new Set<string>()
    stages.forEach((stage, index) => {
      this.count += stage.type === "match" && !stage.action ? 0 : 1
      switch (stage.type) {
        case "match":
          return this.match(stage, scope)
        case "drop":
          return this.drop(stage, scope)
        case "regex": {
          const next = stages[index + 1]
          const helper = stage.expression === LEVEL_EXTRACT_REGEX && next?.type === "drop" && next.source === "level"
          if (!helper) this.warnings.push(`Ignored a regex stage (${short(stage.expression)}): it extracts fields, it doesn't cut anything.`)
          return
        }
        case "sampling":
          if (!(stage.rate > 0 && stage.rate < 1)) {
            this.warnings.push(`Ignored a sampling stage with rate ${stage.rate}: only rates between 0 and 1 cut anything.`)
            return
          }
          return this.add({ kind: "sample", selector: scope.selector, ...(scope.line ? { line: scope.line } : {}), keep: stage.rate, origin: "import" })
        case "structured_metadata":
          if (this.lineScoped(scope, "structured_metadata")) return
          for (const label of stage.labels) {
            metadataLabels.add(label)
            this.add({ kind: "label_to_metadata", selector: scope.selector, label, origin: "import" })
          }
          return
        case "label_drop":
          if (this.lineScoped(scope, "label_drop")) return
          for (const label of stage.labels) {
            // label_drop right after structured_metadata is the second half of a move.
            if (metadataLabels.has(label)) continue
            this.add({ kind: "drop_label", selector: scope.selector, label, origin: "import" })
          }
          return
        case "other":
          this.warnings.push(`Ignored ${stage.name}: no Cardinal log rule matches it.`)
      }
    })
  }

  /** Label stages inside a line-filtered match would apply to some lines only; rules can't say that. */
  lineScoped(scope: Scope, name: string) {
    if (!scope.line) return false
    this.warnings.push(`Ignored ${name} inside a match with a line filter: label rules apply to whole streams.`)
    return true
  }

  match(stage: Extract<Stage, { type: "match" }>, scope: Scope) {
    let parsed
    try {
      parsed = parseLogSelector(stage.selector)
    } catch (error) {
      this.warnings.push(`Ignored a match stage: ${error instanceof Error ? error.message : String(error)}.`)
      return
    }
    if (parsed.rest) {
      this.warnings.push(`Ignored a match on ${short(stage.selector)}: only label matchers and one line filter map to rules.`)
      return
    }
    // Negative line filters are lines a keep rule protects (see compile/stages.ts).
    const negative = parsed.filters.filter((filter) => filter.op === "!=" || filter.op === "!~")
    const { line, problem } = lineFilterFromParsed(parsed.filters.filter((filter) => !negative.includes(filter)))
    if (problem || (line && scope.line)) {
      this.warnings.push(`Ignored a match on ${short(stage.selector)}: ${problem ?? "nested line filters"}.`)
      return
    }
    const selector = { matchers: [...scope.selector.matchers, ...parsed.selector.matchers] }
    const inner: Scope = { selector, line: line ?? scope.line }
    if (negative.length && !this.keepsFromMarkers) {
      for (const filter of negative) {
        const regex = filter.op === "!=" ? escapeRegex(filter.value) : filter.value
        const levels = filter.op === "!~" ? levelsFromLineRegex(filter.value) : null
        this.add({
          kind: "keep",
          selector,
          line: levels ? { levels } : { regex },
          origin: "import",
          rationale: `Imported: the match on ${short(stage.selector)} leaves these lines alone.`,
        })
      }
    }
    if (stage.action === "drop") {
      if (stage.stages?.length) this.warnings.push(`Ignored the nested stages of a dropping match on ${short(stage.selector)}.`)
      if (inner.line) this.add({ kind: "drop_lines", selector, line: inner.line, origin: "import" })
      else this.add({ kind: "drop_streams", selector, origin: "import" })
      return
    }
    this.run(stage.stages ?? [], inner)
  }

  drop(stage: Extract<Stage, { type: "drop" }>, scope: Scope) {
    if (scope.line) {
      this.warnings.push("Ignored a drop stage inside a match with a line filter: a rule has one line filter.")
      return
    }
    let line: LineFilter | undefined
    if (stage.source === undefined || stage.source === "") {
      if (stage.expression) line = { regex: stage.expression }
    } else if (LEVEL_SOURCES.has(stage.source)) {
      const levels = stage.value !== undefined ? normalizeLevels([stage.value]) : levelsFromValueRegex(stage.expression ?? "")
      if (levels?.length) line = { levels }
    }
    if (!line) {
      this.warnings.push(
        `Ignored a drop stage${stage.source ? ` on ${short(stage.source)}` : ""}: only a line regex or a level condition maps to a rule.`
      )
      return
    }
    this.add({ kind: "drop_lines", selector: scope.selector, line, origin: "import" })
  }
}

/** Rules for a stage list, de-duplicated with mergeLogRules. `text` is the source, for keep markers. */
export function rulesFromStages(stages: Stage[], warnings: string[] = [], text = ""): LogImportResult {
  const interpreter = new Interpreter()
  interpreter.warnings.push(...warnings)
  const markers = readKeepMarkers(text)
  interpreter.warnings.push(...markers.warnings)
  interpreter.keepsFromMarkers = markers.keeps.length > 0
  for (const keep of markers.keeps) interpreter.add(keepInput(keep))
  interpreter.run(stages, { selector: { matchers: [] } })
  const created: LogRule[] = []
  for (const input of interpreter.inputs) {
    try {
      created.push(createLogRule(input))
    } catch (error) {
      interpreter.warnings.push(error instanceof Error ? `${error.message}.` : String(error))
    }
  }
  return { rules: mergeLogRules([], created).rules, warnings: interpreter.warnings, ruleCount: interpreter.count }
}
