import * as React from "react"
import { PlusIcon, SparkleIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { metricPath, paths, rulesPath } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { InfoTip } from "@/components/info-tip"
import { Term } from "@/features/rules/term"
import { useAdaptiveRecommendations, useIsGrafanaCloud } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { recommendationSavings, recommendationToRule, type AdaptiveRecommendation } from "@/lib/core/compile/adaptive-metrics"
import { useAppStore } from "@/lib/store/app-store"

function Usage({ rec }: { rec: AdaptiveRecommendation }) {
  const parts = [
    rec.usages_in_dashboards ? `${rec.usages_in_dashboards} dashboards` : null,
    rec.usages_in_queries ? `${rec.usages_in_queries} queries` : null,
    rec.usages_in_rules ? `${rec.usages_in_rules} rules` : null,
  ].filter(Boolean)
  return <span className="text-xs text-muted-foreground">{parts.length ? parts.join(" · ") : "Unused"}</span>
}

function Recommendations() {
  const navigate = useNavigate()
  const { data, isPending, error } = useAdaptiveRecommendations()
  const rules = useAppStore((state) => state.rules)
  const addRules = useAppStore((state) => state.addRules)
  const totalSeries = useAppStore((state) => state.snapshot?.totalSeries ?? 0)
  const [filter, setFilter] = React.useState<"actionable" | "all">("actionable")

  const covered = React.useMemo(() => new Set(rules.filter((rule) => rule.status !== "rejected").map((rule) => rule.selector.metric)), [rules])
  const rows = React.useMemo(
    () =>
      (data ?? [])
        .filter((rec) => filter === "all" || rec.recommended_action === "add" || rec.recommended_action === "update")
        .map((rec) => ({ rec, saved: recommendationSavings(rec) }))
        .sort((a, b) => b.saved - a.saved),
    [data, filter]
  )
  const totalSaved = rows.reduce((sum, row) => sum + row.saved, 0)

  function propose(recs: AdaptiveRecommendation[]) {
    const proposed = recs.map(recommendationToRule).filter((rule) => rule !== null)
    const { added, skipped } = addRules(proposed)
    const skippedText = skipped ? `${skipped} already covered by existing rules` : ""
    if (!added) {
      toast.info(`No new proposals${skippedText ? `: ${skippedText}` : ""}`)
      return
    }
    toast.success(`Added ${added} proposal${added === 1 ? "" : "s"}`, {
      description: skippedText || undefined,
      action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) },
    })
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load recommendations</AlertTitle>
        <AlertDescription>{error.message}. The token needs the adaptive-metrics-recommendations:read scope.</AlertDescription>
      </Alert>
    )
  }

  const uncovered = rows.filter((row) => !covered.has(row.rec.metric)).map((row) => row.rec)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label="Recommendations to show"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "actionable", label: "Actionable" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="flex items-center gap-3">
          {rows.length ? (
            <span className="text-sm text-muted-foreground">
              Up to <span className="font-medium text-foreground tabular-nums">{formatNumber(totalSaved)}</span> series
              {totalSeries ? ` (${((totalSaved / totalSeries) * 100).toFixed(1)}%)` : ""}
            </span>
          ) : null}
          <Button disabled={!uncovered.length} onClick={() => propose(uncovered)}>
            <PlusIcon data-icon="inline-start" />
            Propose all ({uncovered.length})
          </Button>
        </div>
      </div>
      <Card>
        <CardContent>
          {isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={SparkleIcon}
              title="No recommendations"
              description="Grafana has nothing to suggest right now. Recommendations refresh daily."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="hidden md:table-cell">Recommendation</TableHead>
                  <TableHead className="text-right">
                    <Term id="activeSeries">Series</Term>
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Used in</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ rec, saved }) => (
                  <TableRow key={rec.metric}>
                    <TableCell className="max-w-0 min-w-48">
                      <Link
                        to={metricPath(rec.metric)}
                        title={rec.metric}
                        className="block truncate rounded-sm font-mono text-xs hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {rec.metric}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden max-w-72 whitespace-normal md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="secondary">{rec.recommended_action}</Badge>
                        {rec.drop ? <Badge variant="destructive">drop</Badge> : null}
                        {rec.drop_labels?.map((label) => (
                          <Badge key={label} variant="outline" className="font-mono">
                            −{label}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div className="flex flex-col items-end">
                        <span>{formatDelta(-saved)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatNumber(rec.total_series_before_aggregation ?? 0)} → {formatNumber(rec.total_series_after_aggregation ?? 0)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Usage rec={rec} />
                    </TableCell>
                    <TableCell className="text-right">
                      {covered.has(rec.metric) ? (
                        <Badge variant="outline">In rules</Badge>
                      ) : recommendationToRule(rec) ? (
                        <Button size="xs" variant="outline" onClick={() => propose([rec])}>
                          <PlusIcon data-icon="inline-start" />
                          Propose
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}

/** Rules → Recommendations for metrics: Grafana Cloud Adaptive Metrics, proposed into Rules. */
export function AdaptiveMetrics() {
  const cloud = useIsGrafanaCloud()
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        Grafana Cloud's suggestions from actual usage; propose them to review in Rules.
        <InfoTip label="About recommendations">
          Based on which labels your dashboards, queries and alerts use. They aggregate rather than drop, so label removals that merge
          series are safe here. Apply accepted ones from the Rules export.
        </InfoTip>
      </p>
      {cloud ? (
        <Recommendations />
      ) : (
        <EmptyState
          framed
          icon={SparkleIcon}
          title="Connect Grafana Cloud directly"
          description="Recommendations need the stack's Prometheus URL and an access policy token, not Grafana's data source proxy."
        >
          <Button asChild variant="outline">
            <Link to={paths.settings}>Data sources</Link>
          </Button>
        </EmptyState>
      )}
    </div>
  )
}
