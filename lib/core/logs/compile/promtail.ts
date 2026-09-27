// Promtail `pipeline_stages` export. Stage names and fields follow
// https://grafana.com/docs/loki/v3.4.x/send-data/promtail/stages/ (match, drop,
// sampling, labeldrop, structured_metadata, regex).

import { Document } from "yaml"

import {
  compilableRules,
  headerLines,
  ruleCommentLines,
  type LogCompileOptions,
  type LogCompileResult,
} from "@/lib/core/logs/compile/common"
import { collectorSelectorWarnings, ruleStages, type Stage } from "@/lib/core/logs/compile/stages"
import { keepMarker } from "@/lib/core/logs/keep"
import type { LogRule } from "@/lib/core/logs/types"

const SUPPORTED = ["drop_streams", "drop_lines", "sample", "drop_label", "label_to_metadata"] as const

export function promtailStage(stage: Stage): Record<string, unknown> | null {
  switch (stage.type) {
    case "match": {
      const match: Record<string, unknown> = { selector: stage.selector }
      if (stage.action) match.action = stage.action
      if (stage.reason && stage.action === "drop") match.drop_counter_reason = stage.reason
      if (stage.stages?.length) match.stages = stage.stages.map(promtailStage).filter(Boolean)
      return { match }
    }
    case "drop": {
      const drop: Record<string, unknown> = {}
      if (stage.source !== undefined) drop.source = stage.source
      if (stage.expression !== undefined) drop.expression = stage.expression
      if (stage.value !== undefined) drop.value = stage.value
      if (stage.reason) drop.drop_counter_reason = stage.reason
      return { drop }
    }
    case "regex":
      return { regex: { expression: stage.expression } }
    case "sampling":
      // Promtail's sampling stage has no drop_counter_reason.
      return { sampling: { rate: stage.rate } }
    case "structured_metadata":
      return { structured_metadata: Object.fromEntries(stage.labels.map((label) => [label, null])) }
    case "label_drop":
      return { labeldrop: stage.labels }
    case "other":
      return null
  }
}

function yamlList(items: unknown[]) {
  return new Document(items).toString({ lineWidth: 0, nullStr: "", flowCollectionPadding: false }).trimEnd()
}

/** A `pipeline_stages` list with one stage (or match) per active rule. */
export function compilePromtailLogs(rules: LogRule[], options: LogCompileOptions = {}): LogCompileResult {
  const { rules: selected, keeps, warnings } = compilableRules(rules, SUPPORTED, "Promtail", options)
  const body: string[] = []
  const emitted: LogRule[] = []
  for (const rule of selected) {
    const plan = ruleStages(rule, keeps, "Promtail")
    if ("problem" in plan) {
      warnings.push(`Skipped a rule: ${plan.problem}.`)
      continue
    }
    emitted.push(rule)
    if (plan.warnings) warnings.push(...plan.warnings)
    const stages = plan.stages.map(promtailStage).filter(Boolean)
    body.push(...ruleCommentLines(rule, options).map((line) => `  # ${line}`))
    body.push(...yamlList(stages).split("\n").map((line) => `  ${line}`))
  }
  warnings.push(...collectorSelectorWarnings(emitted, "Promtail"))
  if (emitted.length === 0) return { text: "pipeline_stages: []\n", warnings }

  const text = [
    ...headerLines(emitted, options, "Promtail").map((line) => `# ${line}`),
    ...(keeps.length
      ? ["# Keep rules: the stages below leave these lines alone (Cardinal reads these lines back on import).", ...keeps.map((keep) => `# ${keepMarker(keep)}`)]
      : []),
    "# Append these to the pipeline_stages of each scrape config that ships these logs.",
    "pipeline_stages:",
    ...body,
  ].join("\n")
  return { text: `${text}\n`, warnings }
}
