import {
  type DropRuleMetricInput,
  type DropRuleMode,
  type GeneratedDropConfig,
} from "@/lib/prometheus/types"

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sortMetrics(metrics: string[]) {
  return Array.from(new Set(metrics)).sort((a, b) => a.localeCompare(b))
}

function buildRegex(metrics: string[]) {
  return sortMetrics(metrics).map(escapeRegex).join("|") || "^$"
}

function buildMergedInputs(metrics: DropRuleMetricInput[]) {
  const merged = new Map<string, DropRuleMetricInput>()

  for (const item of metrics) {
    const existing = merged.get(item.metric)
    if (!existing) {
      merged.set(item.metric, {
        metric: item.metric,
        topJob: item.topJob,
        dropMetric: Boolean(item.dropMetric),
        droppedLabels: sortMetrics(item.droppedLabels ?? []),
      })
      continue
    }

    merged.set(item.metric, {
      metric: item.metric,
      topJob: existing.topJob ?? item.topJob,
      dropMetric: Boolean(existing.dropMetric || item.dropMetric),
      droppedLabels: sortMetrics([
        ...(existing.droppedLabels ?? []),
        ...(item.droppedLabels ?? []),
      ]),
    })
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.metric.localeCompare(b.metric)
  )
}

function buildPrometheusLabelRewriteRule(
  item: DropRuleMetricInput,
  label: string,
  includeJob: boolean
) {
  if (includeJob && item.topJob) {
    return [
      `  - source_labels: [job, __name__, ${label}]`,
      `    regex: "${escapeRegex(item.topJob)};${escapeRegex(item.metric)};(.+)"`,
      `    target_label: ${label}`,
      '    replacement: ""',
      "    action: replace",
    ]
  }

  return [
    `  - source_labels: [__name__, ${label}]`,
    `    regex: "${escapeRegex(item.metric)};(.+)"`,
    `    target_label: ${label}`,
    '    replacement: ""',
    "    action: replace",
  ]
}

function buildAlloyLabelRewriteRule(
  item: DropRuleMetricInput,
  label: string,
  includeJob: boolean
) {
  if (includeJob && item.topJob) {
    return [
      "  rule {",
      `    source_labels = ["job", "__name__", "${label}"]`,
      '    action        = "replace"',
      `    regex         = "${escapeRegex(item.topJob)};${escapeRegex(item.metric)};(.+)"`,
      `    target_label  = "${label}"`,
      '    replacement   = ""',
      "  }",
    ]
  }

  return [
    "  rule {",
    `    source_labels = ["__name__", "${label}"]`,
    '    action        = "replace"',
    `    regex         = "${escapeRegex(item.metric)};(.+)"`,
    `    target_label  = "${label}"`,
    '    replacement   = ""',
    "  }",
  ]
}

function buildCombinedConfigs(metrics: string[]): GeneratedDropConfig {
  const regex = buildRegex(metrics)

  const prometheusYaml = [
    "metric_relabel_configs:",
    "  - source_labels: [__name__]",
    `    regex: \"${regex}\"`,
    "    action: drop",
  ].join("\n")

  const alloyHcl = [
    'prometheus.relabel "drop_metrics" {',
    "  rule {",
    '    source_labels = ["__name__"]',
    '    action        = "drop"',
    `    regex         = "${regex}"`,
    "  }",
    "}",
  ].join("\n")

  return {
    prometheusYaml,
    alloyHcl,
  }
}

function buildCombinedLabelRules(metrics: DropRuleMetricInput[]) {
  return metrics.flatMap((item) =>
    (item.droppedLabels ?? []).flatMap((label) =>
      buildPrometheusLabelRewriteRule(item, label, false)
    )
  )
}

function buildCombinedAlloyLabelRules(metrics: DropRuleMetricInput[]) {
  return metrics.flatMap((item) =>
    (item.droppedLabels ?? []).flatMap((label) =>
      buildAlloyLabelRewriteRule(item, label, false)
    )
  )
}

function buildSplitByJobConfigs(metrics: DropRuleMetricInput[]): GeneratedDropConfig {
  const grouped = new Map<string, string[]>()

  for (const item of metrics) {
    if (!item.dropMetric) {
      continue
    }
    const key = item.topJob?.trim() || "__unattributed__"
    const group = grouped.get(key)
    if (group) {
      group.push(item.metric)
    } else {
      grouped.set(key, [item.metric])
    }
  }

  const orderedGroups = Array.from(grouped.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )

  const prometheusYaml = [
    "metric_relabel_configs:",
    ...orderedGroups.flatMap(([job, groupMetrics]) => {
      const regex = buildRegex(groupMetrics)
      if (job === "__unattributed__") {
        return [
          "  - source_labels: [__name__]",
          `    regex: \"${regex}\"`,
          "    action: drop",
        ]
      }

      return [
        "  - source_labels: [job, __name__]",
        `    regex: \"${escapeRegex(job)};(${regex})\"`,
        "    action: drop",
      ]
    }),
  ].join("\n")

  const alloyHcl = [
    'prometheus.relabel "drop_metrics" {',
    ...orderedGroups.flatMap(([job, groupMetrics]) => {
      const regex = buildRegex(groupMetrics)
      if (job === "__unattributed__") {
        return [
          "  rule {",
          '    source_labels = ["__name__"]',
          '    action        = "drop"',
          `    regex         = "${regex}"`,
          "  }",
        ]
      }

      return [
        "  rule {",
        '    source_labels = ["job", "__name__"]',
        '    action        = "drop"',
        `    regex         = "${escapeRegex(job)};(${regex})"`,
        "  }",
      ]
    }),
    "}",
  ].join("\n")

  return {
    prometheusYaml,
    alloyHcl,
  }
}

function buildSplitByJobLabelRules(metrics: DropRuleMetricInput[]) {
  return metrics.flatMap((item) =>
    (item.droppedLabels ?? []).flatMap((label) =>
      buildPrometheusLabelRewriteRule(item, label, true)
    )
  )
}

function buildSplitByJobAlloyLabelRules(metrics: DropRuleMetricInput[]) {
  return metrics.flatMap((item) =>
    (item.droppedLabels ?? []).flatMap((label) =>
      buildAlloyLabelRewriteRule(item, label, true)
    )
  )
}

export function generateDropConfigs(
  metrics: DropRuleMetricInput[],
  mode: DropRuleMode = "combined"
): GeneratedDropConfig {
  const deduped = buildMergedInputs(metrics)

  if (mode === "split-by-job") {
    const base = buildSplitByJobConfigs(deduped)
    const prometheusLabelRules = buildSplitByJobLabelRules(deduped)
    const alloyLabelRules = buildSplitByJobAlloyLabelRules(deduped)

    return {
      prometheusYaml: [
        base.prometheusYaml,
        ...prometheusLabelRules,
      ]
        .filter(Boolean)
        .join("\n"),
      alloyHcl: [
        ...base.alloyHcl.split("\n").slice(0, -1),
        ...alloyLabelRules,
        "}",
      ].join("\n"),
    }
  }

  const base = buildCombinedConfigs(
    deduped.filter((item) => item.dropMetric).map((item) => item.metric)
  )
  const prometheusLabelRules = buildCombinedLabelRules(deduped)
  const alloyLabelRules = buildCombinedAlloyLabelRules(deduped)

  return {
    prometheusYaml: [base.prometheusYaml, ...prometheusLabelRules]
      .filter(Boolean)
      .join("\n"),
    alloyHcl: [
      ...base.alloyHcl.split("\n").slice(0, -1),
      ...alloyLabelRules,
      "}",
    ].join("\n"),
  }
}
