import * as React from "react"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { metricPath, paths, rulesPath } from "@/app/paths"
import { useCost } from "@/components/cost-text"
import { SavingsList, type SavingsRowProps } from "@/components/savings-list"
import { Button } from "@/components/ui/button"
import { useChurn } from "@/features/churn/use-churn"
import { useHistogramAnalysis } from "@/features/histograms/use-histograms"
import { useUsageEvidence } from "@/features/rules/usage"
import { cacheDrilldownFor, connectionKey, useConnection } from "@/hooks/use-cardinality"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"
import { DEFAULT_CHURN_WINDOW, rankChurn } from "@/lib/core/churn"
import { createLimiter } from "@/lib/core/concurrency"
import { histogramFamily } from "@/lib/core/families"
import { quantileUsage } from "@/lib/core/histograms"
import { detectIdLike } from "@/lib/core/id-like"
import { jobLabel } from "@/lib/core/jobs"
import {
  bigMetrics,
  bucketOpportunities,
  churnOpportunity,
  idCheckCandidates,
  idLikeOpportunity,
  rankOpportunities,
  reasonLabel,
  unusedMetricOpportunities,
  type MetricOpportunity,
} from "@/lib/core/opportunities"
import { createRule, type Rule, type RuleImpact } from "@/lib/core/rules"
import { snapshotImpact } from "@/lib/core/savings"
import type { Snapshot } from "@/lib/core/snapshot"
import { summarizeEvidence, type UsageEvidence } from "@/lib/core/usage-gate"
import { fetchLabelDrivers } from "@/lib/sources/churn"
import { fetchBucketDistribution, fetchRuleQueries, planFamily } from "@/lib/sources/histograms"
import { fetchMetricDrilldown, fetchTopLabelValues, measureImpact } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

// The Overview's lead: concrete cuts ranked by series saved. Evidence is
// gathered lazily and bounded: rule usage for the 20 largest metrics (one
// /rules call), an ID check on the top labels of the 6 largest metrics, the
// instance-wide histogram query, and churn only when it's already loaded.

const ID_CHECK_METRICS = 6
const CHURN_PAIRS = 2
const scan = createLimiter(2)

/** True/false when usage is known; undefined when the evidence couldn't be read. */
function usedFrom(evidence: UsageEvidence | undefined, label?: string) {
  if (!evidence) return undefined
  if (evidence.rules === null && !evidence.dashboards && !evidence.cloudUsage) return undefined
  return summarizeEvidence(evidence, label).used
}

interface IdLikeFinding {
  metric: string
  label: string
  verdict: NonNullable<ReturnType<typeof detectIdLike>>
  impact: RuleImpact
}

/** ID-like labels among the top labels of the largest metrics, measured (−series if dropped). */
function useIdLikeFindings(snapshot: Snapshot, metrics: string[]) {
  const connection = useConnection()
  const queryClient = useQueryClient()
  const key = connectionKey(connection)
  return useQuery({
    queryKey: ["top-savings-id-like", key, snapshot.capturedAt, metrics],
    enabled: Boolean(connection) && metrics.length > 0,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const findings: IdLikeFinding[] = []
      await Promise.all(
        metrics.map(async (metric) => {
          // Same cache entries as the metric page, so opening it afterwards is instant.
          const drilldown = await queryClient
            .fetchQuery({
              queryKey: ["metric", key, metric, null],
              queryFn: async () => {
                const result = await scan(() => fetchMetricDrilldown(connection!, metric, { signal }))
                cacheDrilldownFor(connection, result)
                return result
              },
              staleTime: 5 * 60_000,
            })
            .catch((error: unknown) => {
              if (signal.aborted) throw error
              return null
            })
          if (!drilldown) return
          for (const { label } of idCheckCandidates(drilldown.labels)) {
            try {
              const values = await queryClient.fetchQuery({
                queryKey: ["label-values", key, metric, label, null],
                queryFn: () => scan(() => fetchTopLabelValues(connection!, metric, label, { limit: 25, signal })),
                staleTime: 5 * 60_000,
              })
              const verdict = detectIdLike(values.map((item) => item.value))
              if (!verdict) continue
              const impact = await queryClient.fetchQuery({
                queryKey: ["label-drop-impact", key, metric, label, null],
                queryFn: () => scan(() => measureImpact(connection!, { kind: "drop_labels", selector: { metric }, labels: [label] }, signal)),
                staleTime: 5 * 60_000,
              })
              findings.push({ metric, label, verdict, impact })
            } catch (error) {
              if (signal.aborted) throw error
            }
          }
        })
      )
      return findings
    },
  })
}

/** Label drivers for the top churning pairs, only once the Overview's churn query has data. */
function useChurnDrivers() {
  const connection = useConnection()
  const key = connectionKey(connection)
  // enabled=false: read the churn card's result, never start the query here.
  const churn = useChurn(DEFAULT_CHURN_WINDOW, false)
  const pairs = React.useMemo(
    () => (churn.data ? rankChurn(churn.data.rows.filter((row) => row.high && row.churned >= 50 && row.metric), CHURN_PAIRS) : []),
    [churn.data]
  )
  const drivers = useQueries({
    queries: pairs.map((row) => ({
      queryKey: ["churn-drivers", key, DEFAULT_CHURN_WINDOW, row.metric, row.job ?? null],
      enabled: Boolean(connection),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchLabelDrivers(connection!, row.metric, DEFAULT_CHURN_WINDOW, { job: row.job, signal }),
      retry: false,
      staleTime: 5 * 60_000,
    })),
  })
  return {
    rows: pairs.map((row, index) => ({ row, driver: drivers[index]?.data?.driver })),
    pending: drivers.some((query) => query.isPending),
  }
}

export function useMetricOpportunities(snapshot: Snapshot) {
  const rules = useAppStore((state) => state.rules)
  const big = React.useMemo(() => bigMetrics(snapshot.metrics, { limit: 20 }), [snapshot.metrics])
  const names = React.useMemo(() => big.map((item) => item.metric), [big])
  const usage = useUsageEvidence(names)
  const used = React.useMemo(() => Object.fromEntries(names.map((metric) => [metric, usedFrom(usage.byMetric[metric])])), [names, usage.byMetric])

  // The ID check skips metrics that can go whole and bucket series (their spread is `le`).
  const idMetrics = React.useMemo(
    () =>
      usage.isPending
        ? []
        : big
            .filter((item) => used[item.metric] !== false && histogramFamily(item.metric).part !== "bucket")
            .slice(0, ID_CHECK_METRICS)
            .map((item) => item.metric),
    [big, used, usage.isPending]
  )
  const idLike = useIdLikeFindings(snapshot, idMetrics)
  const histograms = useHistogramAnalysis()
  const churn = useChurnDrivers()

  const items = React.useMemo(() => {
    const all: MetricOpportunity[] = []
    if (!usage.isPending) {
      const dashboardsChecked = Object.values(usage.byMetric).some((evidence) => Boolean(evidence?.dashboards))
      all.push(...unusedMetricOpportunities(big, used, { dashboardsChecked }))
    }
    for (const finding of idLike.data ?? []) {
      const item = idLikeOpportunity({ ...finding, used: usedFrom(usage.byMetric[finding.metric], finding.label) })
      if (item) all.push(item)
    }
    if (histograms.data) all.push(...bucketOpportunities(histograms.data.families.slice(0, 20)))
    for (const { row, driver } of churn.rows) {
      if (!driver) continue
      const item = churnOpportunity({ metric: row.metric, job: row.job, label: driver.label, churned: row.churned, used: undefined })
      if (item) all.push(item)
    }
    return rankOpportunities(all, rules)
  }, [usage.isPending, usage.byMetric, big, used, idLike.data, histograms.data, churn.rows, rules])

  const impacts = React.useMemo(() => new Map((idLike.data ?? []).map((finding) => [`${finding.metric}\u0000${finding.label}`, finding.impact])), [idLike.data])
  const loading = usage.isPending || (idMetrics.length > 0 && idLike.isPending) || histograms.isPending || churn.pending
  return { items, loading, impacts }
}

/** Creates the opportunity's rule as a proposal; bucket trims are refined with the observed distribution first. */
function useProposeOpportunity(snapshot: Snapshot, impacts: Map<string, RuleImpact>) {
  const connection = useConnection()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const key = connectionKey(connection)
  const families = useHistogramAnalysis().data?.families

  return async (item: MetricOpportunity) => {
    const base = { origin: "user" as const, status: "proposed" as const, rationale: item.rationale }
    const selector = item.rule.job === undefined ? { metric: item.metric } : { metric: item.metric, job: item.rule.job }
    let rule: Rule
    if (item.rule.kind === "drop_metric") {
      rule = createRule({ ...base, kind: "drop_metric", selector })
      rule.impact = snapshotImpact(rule, snapshot) ?? undefined
    } else if (item.rule.kind === "drop_labels") {
      rule = createRule({ ...base, kind: "drop_labels", selector, labels: item.rule.labels, ...(item.rule.onMerge ? { onMerge: item.rule.onMerge } : {}) })
      const measured = item.label && item.rule.job === undefined ? impacts.get(`${item.metric}\u0000${item.label}`) : undefined
      if (measured) rule.impact = measured
    } else {
      let buckets = item.rule.buckets
      const family = families?.find((entry) => entry.bucketMetric === item.metric)
      if (connection && family) {
        try {
          const [distribution, ruleQueries] = await Promise.all([
            fetchBucketDistribution(connection, item.metric),
            queryClient.fetchQuery({ queryKey: ["rule-queries", key], queryFn: ({ signal }) => fetchRuleQueries(connection, signal), staleTime: 5 * 60_000 }),
          ])
          buckets = planFamily(family, distribution, quantileUsage(ruleQueries, item.metric)).suggestion.kept
        } catch {
          // Keep the log-spaced pick.
        }
      }
      rule = createRule({ ...base, kind: "keep_buckets", selector, buckets })
    }
    const { added } = useAppStore.getState().addRules([rule])
    if (!added) {
      toast.info("A rule already covers this")
      return
    }
    toast.success("Proposed", {
      description: `${reasonLabel(item)}: ${item.metric}${item.label ? ` −${item.label}` : ""}`,
      action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) },
    })
  }
}

function itemTitle(item: MetricOpportunity) {
  return item.label ? `${item.metric} · ${item.label}` : item.metric
}

export function TopSavings({ snapshot, className }: { snapshot: Snapshot; className?: string }) {
  const { items, loading, impacts } = useMetricOpportunities(snapshot)
  const propose = useProposeOpportunity(snapshot, impacts)
  const { format } = useCost()
  const open = items.filter((item) => item.state === "open")
  const total = open.reduce((sum, item) => sum + item.savedSeries, 0)

  const rows: SavingsRowProps[] = items.map((item) => ({
    id: item.id,
    reason: reasonLabel(item),
    titleText: itemTitle(item),
    title: (
      <>
        {item.metric}
        {item.label ? <span className="text-brand-ink"> −{item.label}</span> : null}
      </>
    ),
    detail: item.job ? `job ${jobLabel(item.job)}` : undefined,
    to: metricPath(item.metric),
    saving: `${item.estimate ? "~" : ""}${formatDelta(-item.savedSeries)}`,
    cost: format(item.savedSeries) ?? undefined,
    state: item.state,
    onPropose: () => propose(item),
  }))

  return (
    <SavingsList
      className={className}
      rows={rows}
      loading={loading}
      total={total > 0 ? `up to ${formatDelta(-total)} series` : undefined}
      empty={{
        title: "Nothing obvious to cut",
        description: "No unused big metrics, ID-like labels or heavy histograms found.",
        action: (
          <Button asChild variant="outline" size="sm">
            <Link to={paths.explore}>Explore metrics</Link>
          </Button>
        ),
      }}
    />
  )
}
