import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { dashboardEvidenceFor, useGrafanaIndex } from "@/features/usage/use-dashboard-usage"
import { connectionKey, useAdaptiveRecommendations, useConnection, useIsGrafanaCloud } from "@/hooks/use-cardinality"
import type { AdaptiveRecommendation } from "@/lib/core/compile/adaptive-metrics"
import type { Rule } from "@/lib/core/rules"
import { summarizeEvidence, type CloudUsage, type EvidenceSummary, type UsageEvidence } from "@/lib/core/usage-gate"
import { fetchRuleUsage } from "@/lib/sources/prometheus"

// Where metrics are used: Prometheus alerting/recording rules (any backend with
// a rules API), panels and Grafana-managed alerts from the last Grafana scan
// (down to the labels they use) and, on Grafana Cloud, the usage counts
// Adaptive Metrics recommendations carry (dashboards, queries, rules).

export function cloudUsageFor(recs: AdaptiveRecommendation[] | undefined, metric: string): CloudUsage | null {
  const rec = recs?.find((item) => item.metric === metric && (item.match_type ?? "exact") !== "regex")
  if (!rec) return null
  return {
    dashboards: rec.usages_in_dashboards ?? 0,
    queries: rec.usages_in_queries ?? 0,
    rules: rec.usages_in_rules ?? 0,
    keptLabels: rec.kept_labels,
    droppedLabels: rec.drop_labels,
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Usage evidence for each metric; `isPending` while any source is still loading. */
export function useUsageEvidence(metrics: string[], enabled = true) {
  const connection = useConnection()
  const cloud = useIsGrafanaCloud()
  const sorted = React.useMemo(() => Array.from(new Set(metrics)).sort(), [metrics])
  const rules = useQuery({
    queryKey: ["rule-usage-many", connectionKey(connection), sorted],
    enabled: enabled && Boolean(connection) && sorted.length > 0,
    queryFn: ({ signal }) => fetchRuleUsage(connection!, sorted, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const recs = useAdaptiveRecommendations()
  const grafana = useGrafanaIndex()

  const byMetric = React.useMemo(() => {
    const result: Record<string, UsageEvidence> = {}
    for (const metric of sorted) {
      result[metric] = {
        rules: rules.error ? null : (rules.data?.[metric] ?? []),
        rulesError: rules.error ? errorText(rules.error) : undefined,
        cloud,
        cloudUsage: cloud ? cloudUsageFor(recs.data, metric) : null,
        cloudError: cloud && recs.error ? errorText(recs.error) : undefined,
        dashboards: dashboardEvidenceFor(grafana.index, metric),
      }
    }
    return result
  }, [sorted, rules.data, rules.error, cloud, recs.data, recs.error, grafana.index])

  const isPending = (enabled && sorted.length > 0 && rules.isPending && !rules.error) || (cloud && recs.isPending) || grafana.loading
  return { byMetric, isPending }
}

/** Summaries per metric (metric-level evidence), for tables and the PR description. */
export function useUsageSummaries(metrics: string[], enabled = true) {
  const { byMetric, isPending } = useUsageEvidence(metrics, enabled)
  const summaries = React.useMemo(() => {
    const result: Record<string, EvidenceSummary> = {}
    for (const [metric, evidence] of Object.entries(byMetric)) result[metric] = summarizeEvidence(evidence)
    return result
  }, [byMetric])
  return { summaries, isPending }
}

const union = (lists: string[][]) => Array.from(new Set(lists.flat()))

/**
 * Evidence for one rule: metric-level for a metric drop; for a label drop, per
 * dropped label (dashboards are checked down to the label), merged.
 */
export function summarizeRule(rule: Rule, evidence: UsageEvidence | undefined): EvidenceSummary | null {
  if (!evidence) return null
  if (rule.kind !== "drop_labels") return summarizeEvidence(evidence)
  const parts = rule.labels.map((label) => summarizeEvidence(evidence, label))
  return {
    used: parts.some((part) => part.used),
    found: union(parts.map((part) => part.found)),
    unchecked: union(parts.map((part) => part.unchecked)),
    clear: union(parts.map((part) => part.clear)),
    checked: union(parts.map((part) => part.checked)),
    badge: parts.find((part) => part.used && part.badge)?.badge ?? parts[0]?.badge ?? null,
  }
}
