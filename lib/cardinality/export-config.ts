import { GeneratedDropConfig } from "@/lib/prometheus/types"

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function generateDropConfigs(metrics: string[]): GeneratedDropConfig {
  const sorted = Array.from(new Set(metrics)).sort((a, b) => a.localeCompare(b))
  const regex = sorted.map(escapeRegex).join("|") || "^$"

  const prometheusYaml = [
    "metric_relabel_configs:",
    "  - source_labels: [__name__]",
    `    regex: \"${regex}\"`,
    "    action: drop",
  ].join("\n")

  const alloyHcl = [
    'prometheus.relabel "drop_metrics" {',
    "  rule {",
    '    action = "drop"',
    `    regex  = "${regex}"`,
    "  }",
    "}",
  ].join("\n")

  return {
    prometheusYaml,
    alloyHcl,
  }
}
