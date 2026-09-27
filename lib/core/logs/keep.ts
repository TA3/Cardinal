// Keep rules at export time. A keep protects its lines from the other log
// rules; collectors (Alloy, Promtail) have no "keep", so each overlapping drop
// or sample is narrowed instead: a keep of the same or broader streams becomes
// a negative line filter (`!~ "…"`) on the drop's match, and a keep of whole
// streams one label narrower becomes a negated matcher. Anything else can't be
// expressed exactly and is reported. Pure.

import { commentText } from "@/lib/core/logs/compile/common"
import { describeLogRule, keepCoversAll } from "@/lib/core/logs/rules"
import {
  lineFilterRegex,
  normalizeSelector,
  parseLogSelector,
  renderLogSelector,
  renderSelector,
  selectorContains,
  selectorProblem,
  selectorsDisjoint,
  lineFilterFromParsed,
} from "@/lib/core/logs/selector"
import type { KeepRule, LabelMatcher, LineFilter, LogRule, MatchOp, StreamSelector } from "@/lib/core/logs/types"
import { quoteLogQLValue } from "@/lib/core/logql"

const NEGATE: Record<MatchOp, MatchOp> = { "=": "!=", "!=": "=", "=~": "!~", "!~": "=~" }

export interface KeepExclusion {
  /** The rule's streams minus kept streams; null when a keep protects every line it would remove. */
  selector: StreamSelector | null
  /** Kept lines to leave alone, rendered as `!~` filters. */
  exclude: LineFilter[]
  /** Keeps folded into `selector` / `exclude`. */
  applied: KeepRule[]
  /** Overlapping keeps that can't be expressed: the rule still removes their lines. */
  unexpressed: KeepRule[]
}

/**
 * Narrows a drop or sample so it leaves the kept lines alone, where a collector
 * match can say so:
 * - a keep of every line (or of the rule's own lines) of the same or broader streams protects it entirely (`selector: null`);
 * - a keep of some lines of the same or broader streams adds `!~ "<keep regex>"`;
 * - a keep of every line of streams narrower by one matcher adds that matcher negated;
 * - anything else (narrower streams plus a line filter, several extra matchers,
 *   or an unscoped rule) is `unexpressed`.
 */
export function excludeKeeps(rule: Pick<LogRule, "selector"> & { line?: LineFilter }, keeps: KeepRule[]): KeepExclusion {
  let selector = rule.selector
  const exclude: LineFilter[] = []
  const applied: KeepRule[] = []
  const unexpressed: KeepRule[] = []
  for (const keep of keeps) {
    if (selectorsDisjoint(keep.selector, selector)) continue
    if (selectorContains(keep.selector, selector)) {
      if (!keep.line || keepCoversAll(keep, selector, rule.line)) return { selector: null, exclude: [], applied: [keep], unexpressed: [] }
      // A line filter needs a stage.match, and a match needs a selector.
      if (selector.matchers.length === 0) unexpressed.push(keep)
      else {
        exclude.push(keep.line)
        applied.push(keep)
      }
      continue
    }
    const extra = keep.selector.matchers.filter((matcher) => !selectorContains({ matchers: [matcher] }, selector))
    if (!keep.line && extra.length === 1) {
      const negated: LabelMatcher = { ...extra[0], op: NEGATE[extra[0].op] }
      const next = normalizeSelector({ matchers: [...selector.matchers, negated] })
      if (selector.matchers.length > 0 && !selectorProblem(next)) {
        selector = next
        applied.push(keep)
        continue
      }
    }
    unexpressed.push(keep)
  }
  return { selector, exclude, applied, unexpressed }
}

/** ` !~ "…"` for each kept line filter. */
export function renderExcludes(exclude: LineFilter[]) {
  return exclude.map((line) => ` !~ ${quoteLogQLValue(lineFilterRegex(line))}`).join("")
}

/** The match selector of a narrowed rule: streams, its own line filter, then the kept lines left out. */
export function narrowedSelector(selector: StreamSelector, line: LineFilter | undefined, exclude: LineFilter[]) {
  return `${renderLogSelector(selector, line)}${renderExcludes(exclude)}`
}

/** A warning for keeps a rule can't leave alone in `target`. */
export function unexpressedWarning(rule: LogRule, keeps: KeepRule[], target: string) {
  const names = keeps.map((keep) => `"${describeLogRule(keep)}"`).join(", ")
  return `"${describeLogRule(rule)}" overlaps keep rule${keeps.length === 1 ? "" : "s"} ${names}, which ${target} can't exclude from it: it still removes those lines. Narrow its selector, or make the keep cover whole streams one label narrower.`
}

// ---- markers ----

/** Comment marker for a keep in collector exports, read back on import. */
export const KEEP_MARKER = "cardinal:keep"

/** `cardinal:keep {service_name="api"} |~ "health" why: audit`. */
export function keepMarker(rule: KeepRule) {
  const selector = rule.selector.matchers.length ? renderSelector(rule.selector) : "{}"
  const line = rule.line ? ` |~ ${quoteLogQLValue(lineFilterRegex(rule.line))}` : ""
  const why = commentText(rule.rationale ?? "", 300)
  return `${KEEP_MARKER} ${selector}${line} why: ${why}`
}

export interface ParsedKeepMarker {
  selector: StreamSelector
  line?: LineFilter
  rationale: string
}

/** Keep markers in an exported config (`// cardinal:keep …` or `# cardinal:keep …`). */
export function readKeepMarkers(text: string): { keeps: ParsedKeepMarker[]; warnings: string[] } {
  const keeps: ParsedKeepMarker[] = []
  const warnings: string[] = []
  const pattern = new RegExp(`^\\s*(?://|#)\\s*${KEEP_MARKER}\\s+(.+)$`, "gm")
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = parseLogSelector(match[1])
      const { line, problem } = lineFilterFromParsed(parsed.filters)
      if (problem) throw new Error(problem)
      const rationale = /^why:\s*(.*)$/.exec(parsed.rest)?.[1]?.trim() || "Imported keep rule."
      keeps.push({ selector: parsed.selector, ...(line ? { line } : {}), rationale })
    } catch (error) {
      warnings.push(`Ignored a keep marker (${match[1].slice(0, 60)}): ${error instanceof Error ? error.message : String(error)}.`)
    }
  }
  return { keeps, warnings }
}
