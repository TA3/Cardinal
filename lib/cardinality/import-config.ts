import { type DropRuleMetricInput } from "@/lib/prometheus/types"

export interface ParsedLabelDrop {
  metric: string
  label: string
}

export interface ParsedImportRules {
  dropMetrics: string[]
  labelDrops: ParsedLabelDrop[]
  warnings: string[]
  ruleCount: number
  skippedCount: number
}

interface ParsedRule {
  sourceLabels: string[]
  action?: string
  regex?: string
  targetLabel?: string
  replacement?: string
}

function trimQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseList(value: string): string[] {
  const start = value.indexOf("[")
  const end = value.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) {
    return []
  }
  return value
    .slice(start + 1, end)
    .split(",")
    .map((item) => trimQuotes(item))
    .map((item) => item.trim())
    .filter(Boolean)
}

function unescapeRegexToken(value: string): string {
  return value.replace(/\\(.)/g, "$1")
}

function stripWrappedParens(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed
  }

  let depth = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === "\\") {
      i += 1
      continue
    }
    if (char === "(") {
      depth += 1
    } else if (char === ")") {
      depth -= 1
      if (depth === 0 && i < trimmed.length - 1) {
        return trimmed
      }
    }
  }

  return trimmed.slice(1, -1).trim()
}

function splitTopLevelAlternation(value: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (char === "\\") {
      i += 1
      continue
    }
    if (char === "(") {
      depth += 1
      continue
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === "|" && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }

  parts.push(value.slice(start))
  return parts.map((item) => item.trim()).filter(Boolean)
}

function normalizeMetricRegexToken(value: string): string {
  const trimmed = value.trim().replace(/^\^/, "").replace(/\$$/, "")
  return unescapeRegexToken(stripWrappedParens(trimmed))
}

function extractDropMetrics(regex: string, includeJob: boolean): string[] {
  const cleaned = trimQuotes(regex)
  const scope = includeJob
    ? cleaned.slice(cleaned.indexOf(";") + 1)
    : cleaned

  if (!scope || scope === cleaned && includeJob && !cleaned.includes(";")) {
    return []
  }

  const alternation = splitTopLevelAlternation(stripWrappedParens(scope))
  return alternation
    .map(normalizeMetricRegexToken)
    .filter((item) => item.length > 0 && item !== "(.+)" && item !== ".+")
}

function extractLabelRuleMetric(regex: string, includeJob: boolean): string | null {
  const parts = trimQuotes(regex).split(";")
  const metricIndex = includeJob ? 1 : 0
  if (parts.length <= metricIndex) {
    return null
  }
  const metric = normalizeMetricRegexToken(parts[metricIndex])
  return metric || null
}

function dedupeAndSort(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function parseRule(source: ParsedRule, warnings: string[], index: number): {
  dropMetrics: string[]
  labelDrops: ParsedLabelDrop[]
} {
  const sourceLabels = source.sourceLabels
  const action = source.action?.trim()

  if (!action || sourceLabels.length === 0) {
    warnings.push(`Rule ${index}: missing action or source_labels`)
    return { dropMetrics: [], labelDrops: [] }
  }

  if (action === "drop") {
    if (sourceLabels.length === 1 && sourceLabels[0] === "__name__" && source.regex) {
      return {
        dropMetrics: extractDropMetrics(source.regex, false),
        labelDrops: [],
      }
    }

    if (
      sourceLabels.length === 2 &&
      sourceLabels[0] === "job" &&
      sourceLabels[1] === "__name__" &&
      source.regex
    ) {
      return {
        dropMetrics: extractDropMetrics(source.regex, true),
        labelDrops: [],
      }
    }

    warnings.push(`Rule ${index}: unsupported drop rule shape`)
    return { dropMetrics: [], labelDrops: [] }
  }

  if (action === "replace") {
    const includeJob =
      sourceLabels.length === 3 &&
      sourceLabels[0] === "job" &&
      sourceLabels[1] === "__name__"

    const isCombined = sourceLabels.length === 2 && sourceLabels[0] === "__name__"

    if ((includeJob || isCombined) && source.regex) {
      const metric = extractLabelRuleMetric(source.regex, includeJob)
      const inferredLabel = source.targetLabel || sourceLabels[sourceLabels.length - 1]
      const replacement = source.replacement ?? ""

      if (metric && inferredLabel && replacement === "") {
        return {
          dropMetrics: [],
          labelDrops: [{ metric, label: inferredLabel }],
        }
      }
    }

    warnings.push(`Rule ${index}: unsupported replace rule shape`)
    return { dropMetrics: [], labelDrops: [] }
  }

  warnings.push(`Rule ${index}: unsupported action '${action}'`)
  return { dropMetrics: [], labelDrops: [] }
}

export function parsePrometheusRules(text: string): ParsedImportRules {
  const warnings: string[] = []
  const dropMetrics: string[] = []
  const labelDrops: ParsedLabelDrop[] = []

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))

  const blocks: string[][] = []
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith("- ")) {
      if (current.length > 0) {
        blocks.push(current)
      }
      current = [line.slice(2)]
      continue
    }

    if (line === "metric_relabel_configs:") {
      continue
    }

    if (current.length > 0) {
      current.push(line)
    }
  }

  if (current.length > 0) {
    blocks.push(current)
  }

  blocks.forEach((block, index) => {
    const parsed: ParsedRule = { sourceLabels: [] }

    for (const entry of block) {
      if (entry.startsWith("source_labels:")) {
        parsed.sourceLabels = parseList(entry)
      } else if (entry.startsWith("action:")) {
        parsed.action = trimQuotes(entry.split(":").slice(1).join(":").trim())
      } else if (entry.startsWith("regex:")) {
        parsed.regex = trimQuotes(entry.split(":").slice(1).join(":").trim())
      } else if (entry.startsWith("target_label:")) {
        parsed.targetLabel = trimQuotes(entry.split(":").slice(1).join(":").trim())
      } else if (entry.startsWith("replacement:")) {
        parsed.replacement = trimQuotes(entry.split(":").slice(1).join(":").trim())
      }
    }

    const out = parseRule(parsed, warnings, index + 1)
    dropMetrics.push(...out.dropMetrics)
    labelDrops.push(...out.labelDrops)
  })

  const dedupedLabelDrops = Array.from(
    new Map(labelDrops.map((item) => [`${item.metric}::${item.label}`, item])).values()
  ).sort((a, b) =>
    a.metric === b.metric ? a.label.localeCompare(b.label) : a.metric.localeCompare(b.metric)
  )

  return {
    dropMetrics: dedupeAndSort(dropMetrics),
    labelDrops: dedupedLabelDrops,
    warnings,
    ruleCount: blocks.length,
    skippedCount: warnings.length,
  }
}

export function parseAlloyRules(text: string): ParsedImportRules {
  const warnings: string[] = []
  const dropMetrics: string[] = []
  const labelDrops: ParsedLabelDrop[] = []

  const ruleBlocks = Array.from(text.matchAll(/rule\s*\{([\s\S]*?)\}/g)).map(
    (match) => match[1]
  )

  ruleBlocks.forEach((block, index) => {
    const parsed: ParsedRule = { sourceLabels: [] }
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      if (line.startsWith("source_labels")) {
        const rhs = line.split("=").slice(1).join("=").trim()
        parsed.sourceLabels = parseList(rhs)
      } else if (line.startsWith("action")) {
        parsed.action = trimQuotes(line.split("=").slice(1).join("=").trim())
      } else if (line.startsWith("regex")) {
        parsed.regex = trimQuotes(line.split("=").slice(1).join("=").trim())
      } else if (line.startsWith("target_label")) {
        parsed.targetLabel = trimQuotes(line.split("=").slice(1).join("=").trim())
      } else if (line.startsWith("replacement")) {
        parsed.replacement = trimQuotes(line.split("=").slice(1).join("=").trim())
      }
    }

    const out = parseRule(parsed, warnings, index + 1)
    dropMetrics.push(...out.dropMetrics)
    labelDrops.push(...out.labelDrops)
  })

  const dedupedLabelDrops = Array.from(
    new Map(labelDrops.map((item) => [`${item.metric}::${item.label}`, item])).values()
  ).sort((a, b) =>
    a.metric === b.metric ? a.label.localeCompare(b.label) : a.metric.localeCompare(b.metric)
  )

  return {
    dropMetrics: dedupeAndSort(dropMetrics),
    labelDrops: dedupedLabelDrops,
    warnings,
    ruleCount: ruleBlocks.length,
    skippedCount: warnings.length,
  }
}

export function toSelectedLabelsByMetric(
  labelDrops: ParsedLabelDrop[]
): Record<string, string[]> {
  const grouped = new Map<string, Set<string>>()

  for (const { metric, label } of labelDrops) {
    const current = grouped.get(metric)
    if (current) {
      current.add(label)
    } else {
      grouped.set(metric, new Set([label]))
    }
  }

  return Array.from(grouped.entries()).reduce<Record<string, string[]>>(
    (acc, [metric, labels]) => ({
      ...acc,
      [metric]: Array.from(labels).sort((a, b) => a.localeCompare(b)),
    }),
    {}
  )
}

export function toDropRuleMetricInputs(
  dropMetrics: string[],
  selectedLabelsByMetric: Record<string, string[]>
): DropRuleMetricInput[] {
  const metricNames = Array.from(
    new Set([
      ...dropMetrics,
      ...Object.keys(selectedLabelsByMetric).filter(
        (metric) => (selectedLabelsByMetric[metric] ?? []).length > 0
      ),
    ])
  ).sort((a, b) => a.localeCompare(b))

  return metricNames.map((metric) => ({
    metric,
    dropMetric: dropMetrics.includes(metric),
    droppedLabels: selectedLabelsByMetric[metric] ?? [],
  }))
}
