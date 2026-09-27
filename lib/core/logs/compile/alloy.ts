// Grafana Alloy `loki.process` export. Stage and attribute names follow
// https://grafana.com/docs/alloy/latest/reference/components/loki/loki.process/

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

/** Alloy string literal (Go-style escapes; JSON's are a subset). */
export function alloyString(value: string) {
  return JSON.stringify(value)
}

function attrLines(pairs: Array<[string, string]>, indent: string) {
  const width = Math.max(...pairs.map(([key]) => key.length))
  return pairs.map(([key, value]) => `${indent}${key.padEnd(width)} = ${value}`)
}

function list(values: string[]) {
  return `[${values.map(alloyString).join(", ")}]`
}

export function renderAlloyStage(stage: Stage, indent = "  "): string[] {
  const inner = `${indent}  `
  const block = (name: string, body: string[]) => [`${indent}stage.${name} {`, ...body, `${indent}}`]
  switch (stage.type) {
    case "match": {
      const pairs: Array<[string, string]> = [["selector", alloyString(stage.selector)]]
      if (stage.action) pairs.push(["action", alloyString(stage.action)])
      if (stage.reason && stage.action === "drop") pairs.push(["drop_counter_reason", alloyString(stage.reason)])
      const nested = (stage.stages ?? []).flatMap((child) => ["", ...renderAlloyStage(child, inner)])
      return block("match", [...attrLines(pairs, inner), ...nested])
    }
    case "drop": {
      const pairs: Array<[string, string]> = []
      if (stage.source !== undefined) pairs.push(["source", alloyString(stage.source)])
      if (stage.expression !== undefined) pairs.push(["expression", alloyString(stage.expression)])
      if (stage.value !== undefined) pairs.push(["value", alloyString(stage.value)])
      if (stage.reason) pairs.push(["drop_counter_reason", alloyString(stage.reason)])
      return block("drop", attrLines(pairs, inner))
    }
    case "regex":
      return block("regex", attrLines([["expression", alloyString(stage.expression)]], inner))
    case "sampling": {
      const pairs: Array<[string, string]> = [["rate", String(stage.rate)]]
      if (stage.reason) pairs.push(["drop_counter_reason", alloyString(stage.reason)])
      return block("sampling", attrLines(pairs, inner))
    }
    case "structured_metadata":
      // An empty value reads the extracted value with the same name; labels are in the extracted map.
      return block("structured_metadata", [
        `${inner}values = {`,
        ...stage.labels.map((label) => `${inner}  ${label} = "",`),
        `${inner}}`,
      ])
    case "label_drop":
      return block("label_drop", attrLines([["values", list(stage.labels)]], inner))
    case "other":
      return []
  }
}

/**
 * A `loki.process "cardinal"` component with one stage (or stage.match) per
 * active rule, in stage order. Retention and anything shadowed are skipped
 * with a warning.
 */
export function compileAlloyLogs(rules: LogRule[], options: LogCompileOptions = {}): LogCompileResult {
  const { rules: selected, keeps, warnings } = compilableRules(rules, SUPPORTED, "Alloy", options)
  const body: string[] = []
  const emitted: LogRule[] = []
  for (const rule of selected) {
    const plan = ruleStages(rule, keeps, "Alloy")
    if ("problem" in plan) {
      warnings.push(`Skipped a rule: ${plan.problem}.`)
      continue
    }
    emitted.push(rule)
    if (plan.warnings) warnings.push(...plan.warnings)
    body.push("", ...ruleCommentLines(rule, options).map((line) => `  // ${line}`))
    for (const stage of plan.stages) body.push(...renderAlloyStage(stage))
  }
  warnings.push(...collectorSelectorWarnings(emitted, "Alloy"))
  if (emitted.length === 0) return { text: "// No log rules to export for Alloy\n", warnings }

  const text = [
    ...headerLines(emitted, options, "Grafana Alloy").map((line) => `// ${line}`),
    ...(keeps.length
      ? ["// Keep rules: the stages below leave these lines alone (Cardinal reads these lines back on import).", ...keeps.map((keep) => `// ${keepMarker(keep)}`)]
      : []),
    "// Send your log sources here (forward_to = [loki.process.cardinal.receiver]).",
    'loki.process "cardinal" {',
    "  // Point this at your existing loki.write receiver.",
    "  forward_to = [loki.write.default.receiver]",
    ...body,
    "}",
  ].join("\n")
  return { text: `${text}\n`, warnings }
}
