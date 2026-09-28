import type { RelabelPlan, RelabelSection, RelabelStep } from "@/lib/core/compile/plan"
import { toRelabelConfigs, type RelabelConfig } from "@/lib/core/compile/prometheus"
import { escapeJoinedPart, joinSeparator, literalAlternation } from "@/lib/core/regex"

/** Alloy syntax string literal (Go-style escapes). */
export function alloyString(value: string) {
  return JSON.stringify(value)
}

function componentSlug(job: string | undefined) {
  if (job === undefined) return "cardinal"
  const slug = job.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  return `cardinal_${slug || (job === "" ? "no_job" : "job")}`
}

/** Component labels per section, de-duplicated with a numeric suffix (`api-server` vs `api_server`). */
function componentLabels(sections: RelabelSection[]) {
  const used = new Set<string>()
  return sections.map((section) => {
    const base = componentSlug(section.job)
    let label = base
    for (let n = 2; used.has(label); n += 1) label = `${base}_${n}`
    used.add(label)
    return label
  })
}

function joinedAttrs(job: string, sourceLabels: string[], rest: string): Array<[string, string]> {
  const separator = joinSeparator(job)
  const attrs: Array<[string, string]> = [["source_labels", `[${sourceLabels.map(alloyString).join(", ")}]`]]
  if (separator !== ";") attrs.push(["separator", alloyString(separator)])
  attrs.push(["regex", alloyString(`${escapeJoinedPart(job, separator)}${separator}${rest.split(";").join(separator)}`)])
  return attrs
}

function configAttrs(config: RelabelConfig): Array<[string, string]> {
  const attrs: Array<[string, string]> = []
  if (config.source_labels) attrs.push(["source_labels", `[${config.source_labels.map(alloyString).join(", ")}]`])
  if (config.separator !== undefined) attrs.push(["separator", alloyString(config.separator)])
  attrs.push(["regex", alloyString(config.regex)])
  attrs.push(["action", alloyString(config.action)])
  if (config.target_label !== undefined) attrs.push(["target_label", alloyString(config.target_label)])
  if (config.replacement !== undefined) attrs.push(["replacement", alloyString(config.replacement)])
  return attrs
}

function ruleBlock(attrs: Array<[string, string]>) {
  const width = Math.max(...attrs.map(([key]) => key.length))
  return ["  rule {", ...attrs.map(([key, value]) => `    ${key.padEnd(width)} = ${value}`), "  }"].join("\n")
}

function renderStep(step: RelabelStep) {
  if (step.kind === "drop_series" || step.kind === "keep_buckets" || step.kind === "keep_value") {
    return toRelabelConfigs(step).map((config) => ruleBlock(configAttrs(config))).join("\n")
  }
  let attrs: Array<[string, string]>
  if (step.kind === "drop") {
    const names = literalAlternation(step.metrics)
    attrs =
      step.job !== undefined
        ? [...joinedAttrs(step.job, ["job", "__name__"], `(${names})`), ["action", alloyString("drop")]]
        : [
            ["source_labels", `[${alloyString("__name__")}]`],
            ["regex", alloyString(names)],
            ["action", alloyString("drop")],
          ]
  } else {
    const metric = escapeJoinedPart(step.metric)
    attrs = [
      ...(step.job !== undefined
        ? joinedAttrs(step.job, ["job", "__name__", step.label], `${metric};.+`)
        : ([
            ["source_labels", `[${alloyString("__name__")}, ${alloyString(step.label)}]`],
            ["regex", alloyString(`${metric};.+`)],
          ] as Array<[string, string]>)),
      ["action", alloyString("replace")],
      ["target_label", alloyString(step.label)],
      ["replacement", alloyString("")],
    ]
  }

  return ruleBlock(attrs)
}

function renderSection(section: RelabelSection, label: string) {
  // JSON-quoted so a job containing a newline cannot end the comment.
  const header = section.job !== undefined ? `// scrape job: ${JSON.stringify(section.job)}\n` : ""
  return [
    `${header}prometheus.relabel ${alloyString(label)} {`,
    "  // Point this at your existing remote_write receiver.",
    "  forward_to = [prometheus.remote_write.default.receiver]",
    "",
    ...section.steps.map(renderStep),
    "}",
  ].join("\n")
}

export function renderAlloy(plan: RelabelPlan) {
  const sections = plan.sections.filter((section) => section.steps.length > 0)
  if (sections.length === 0) return "// No rules selected\n"
  const labels = componentLabels(sections)
  return `${sections.map((section, index) => renderSection(section, labels[index])).join("\n\n")}\n`
}
