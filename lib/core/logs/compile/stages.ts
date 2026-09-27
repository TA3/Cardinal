// Collector pipeline stages shared by the Alloy (loki.process) and Promtail
// (pipeline_stages) compilers, which differ only in syntax. The importers read
// both formats back into this shape.

import { DROP_REASON } from "@/lib/core/logs/compile/common"
import { excludeKeeps, narrowedSelector, unexpressedWarning } from "@/lib/core/logs/keep"
import {
  LEVEL_EXTRACT_REGEX,
  levelValueRegex,
  renderLogSelector,
  renderSelector,
} from "@/lib/core/logs/selector"
import type { KeepRule, LogRule } from "@/lib/core/logs/types"

export type Stage =
  | { type: "match"; selector: string; action?: "drop"; reason?: string; stages?: Stage[] }
  | { type: "drop"; expression?: string; source?: string; value?: string; reason?: string }
  | { type: "regex"; expression: string }
  | { type: "sampling"; rate: number; reason?: string }
  | { type: "structured_metadata"; labels: string[] }
  | { type: "label_drop"; labels: string[] }
  /** Any stage Cardinal doesn't model, kept for warnings. */
  | { type: "other"; name: string }

function scoped(rule: LogRule, stages: Stage[]): Stage[] {
  if (rule.selector.matchers.length === 0) return stages
  return [{ type: "match", selector: renderSelector(rule.selector), stages }]
}

export type RuleStages = { stages: Stage[]; warnings?: string[] } | { problem: string }

/**
 * The stages for one rule, or a reason it can't be expressed in a collector.
 * Drops and samples leave the lines of overlapping `keeps` alone where a match
 * selector can say so (see excludeKeeps); the rest is a warning.
 */
export function ruleStages(rule: LogRule, keeps: KeepRule[] = [], target = "the collector"): RuleStages {
  if (keeps.length && (rule.kind === "drop_streams" || rule.kind === "drop_lines" || rule.kind === "sample")) {
    const exclusion = excludeKeeps({ selector: rule.selector, line: rule.kind === "drop_streams" ? undefined : rule.line }, keeps)
    if (!exclusion.selector) return { problem: `a keep rule protects every line of "${rule.kind}" on these streams` }
    const warnings = exclusion.unexpressed.length ? [unexpressedWarning(rule, exclusion.unexpressed, target)] : []
    const reason = `${DROP_REASON}_${rule.kind}`
    const narrowed = { ...rule, selector: exclusion.selector }
    if (!exclusion.exclude.length) {
      const plain = ruleStages(narrowed)
      return "problem" in plain ? plain : { stages: plain.stages, warnings }
    }
    const line = rule.kind === "drop_streams" ? undefined : rule.line
    const selector = narrowedSelector(exclusion.selector, line, exclusion.exclude)
    const stages: Stage[] =
      rule.kind === "sample"
        ? [{ type: "match", selector, stages: [{ type: "sampling", rate: rule.keep, reason }] }]
        : [{ type: "match", selector, action: "drop", reason }]
    return { stages, warnings }
  }
  const reason = `${DROP_REASON}_${rule.kind}`
  switch (rule.kind) {
    case "drop_streams":
      return { stages: [{ type: "match", selector: renderSelector(rule.selector), action: "drop", reason }] }
    case "drop_lines":
      if (rule.line.levels?.length) {
        // Extract the level from the line (keeps a `level` label when the line has none), then drop on it.
        return {
          stages: scoped(rule, [
            { type: "regex", expression: LEVEL_EXTRACT_REGEX },
            { type: "drop", source: "level", expression: levelValueRegex(rule.line.levels), reason },
          ]),
        }
      }
      return { stages: scoped(rule, [{ type: "drop", expression: rule.line.regex, reason }]) }
    case "sample": {
      const sampling: Stage = { type: "sampling", rate: rule.keep, reason }
      if (!rule.line) return { stages: scoped(rule, [sampling]) }
      if (rule.selector.matchers.length === 0) {
        return { problem: "a sample with a line filter needs a selector to scope the stage.match" }
      }
      return { stages: [{ type: "match", selector: renderLogSelector(rule.selector, rule.line), stages: [sampling] }] }
    }
    case "drop_label":
      return { stages: scoped(rule, [{ type: "label_drop", labels: [rule.label] }]) }
    case "label_to_metadata":
      // structured_metadata reads the label from the extracted map; label_drop makes sure it leaves the stream.
      return {
        stages: scoped(rule, [
          { type: "structured_metadata", labels: [rule.label] },
          { type: "label_drop", labels: [rule.label] },
        ]),
      }
    case "retention":
      return { problem: "retention is enforced by Loki's compactor, not the collector" }
    case "keep":
      return { problem: "a keep is not a stage; it narrows the drops it overlaps" }
  }
}

/** Warns when a compiled selector relies on labels a collector often doesn't have yet. */
export function collectorSelectorWarnings(rules: LogRule[], target: string) {
  const usesServiceName = rules.some((rule) => rule.selector.matchers.some((matcher) => matcher.label === "service_name"))
  return usesServiceName
    ? [
        `Some selectors use service_name, which Loki often derives at ingestion. If ${target} doesn't set it, rewrite those selectors with the source label (app, job, container…).`,
      ]
    : []
}
