import * as React from "react"
import { ArrowClockwiseIcon, ShieldCheckIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { Link, useLocation, useSearchParams } from "react-router"

import { metricPath, paths } from "@/app/paths"
import { useCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { AnimatedNumber } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RuleActions, RuleDescription, RuleImpact, RuleOriginBadge } from "@/components/rule-parts"
import { SegmentedControl } from "@/components/segmented-control"
import { SignalBadge } from "@/components/signal-badge"
import { UsedBadge } from "@/components/used-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdaptiveMetrics } from "@/features/adaptive/adaptive-metrics"
import { AcceptAllButton } from "@/features/rules/accept-all"
import { RuleDestinationStep } from "@/features/rules/destination"
import { ExportCard, MetricPlanActions, useMetricsExport, type ExportOutput } from "@/features/rules/export-card"
import { ImportDialog } from "@/features/rules/import-dialog"
import { LogRulesPage } from "@/features/rules/log-rules-page"
import { PlanHeader } from "@/features/rules/plan-header"
import { RuleMergeControl, useUnusedMerges } from "@/features/rules/merge-choice"
import { hasLogShareHash } from "@/features/rules/log-share"
import { SharedRulesBanner, ShareMenu } from "@/features/rules/share"
import { Term } from "@/features/rules/term"
import { useUsageSummaries } from "@/features/rules/usage"
import { useMetricsTarget, useRefreshSnapshot, useSavings, useSnapshotAge } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { METRICS_DESTINATIONS } from "@/lib/core/backend-profile"
import { shadowedBy, type Rule, type RuleStatus } from "@/lib/core/rules"
import { SHARE_HASH_KEY } from "@/lib/core/share"
import { useAppStore } from "@/lib/store/app-store"

type View = "rules" | "recommendations"

const TABS: readonly RuleStatus[] = ["active", "proposed", "rejected"]
const TAB_LABEL: Record<RuleStatus, string> = { active: "Active", proposed: "Proposed", rejected: "Rejected" }

function isRuleStatus(value: string | null): value is RuleStatus {
  return TABS.includes(value as RuleStatus)
}

const EMPTY_COPY: Record<RuleStatus, { title: string; text: string }> = {
  active: { title: "No rules yet", text: "Drop metrics or labels while exploring, or import your current rules." },
  proposed: { title: "Nothing to review", text: "Agent suggestions land here." },
  rejected: { title: "Nothing rejected", text: "Rejected proposals stay here." } }

function RulesTable({ rules, allRules, status, totalSeries }: { rules: Rule[]; allRules: Rule[]; status: RuleStatus; totalSeries: number }) {
  const metrics = React.useMemo(() => rules.map((rule) => rule.selector.metric), [rules])
  const { summaries, isPending } = useUsageSummaries(metrics, status !== "rejected" && rules.length > 0)
  const { unused } = useUnusedMerges(rules)
  const { adaptive } = useMetricsTarget()
  if (rules.length === 0) {
    const text = status === "proposed" && adaptive ? "Agent and Adaptive Metrics suggestions land here." : EMPTY_COPY[status].text
    return (
      <EmptyState icon={ShieldCheckIcon} title={EMPTY_COPY[status].title} description={text}>
        {status === "active" ? (
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link to={paths.explore}>Explore metrics</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.agent}>Use an agent</Link>
            </Button>
          </div>
        ) : null}
      </EmptyState>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead className="hidden md:table-cell">Source</TableHead>
          {status !== "rejected" ? <TableHead className="hidden sm:table-cell">Used</TableHead> : null}
          <TableHead className="hidden text-right sm:table-cell">Saves</TableHead>
          <TableHead className="w-20 sm:w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell className="max-w-0 whitespace-normal sm:min-w-56">
              <Link
                to={metricPath(rule.selector.metric)}
                title={rule.selector.metric}
                className="block rounded-lg hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <RuleDescription rule={rule} supersededBy={rule.status === "active" ? shadowedBy(rule, allRules) : undefined} />
              </Link>
              {rule.rationale ? <p className="mt-1 hidden text-xs text-muted-foreground sm:line-clamp-2">{rule.rationale}</p> : null}
              {rule.impact ? (
                <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums sm:hidden">
                  {formatDelta(rule.impact.seriesAfter - rule.impact.seriesBefore)} series
                </span>
              ) : null}
              {status === "rejected" ? null : <RuleMergeControl rule={rule} unused={unused.has(rule.id)} className="mt-1.5" />}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <RuleOriginBadge rule={rule} />
            </TableCell>
            {status !== "rejected" ? (
              <TableCell className="hidden sm:table-cell">
                <UsedBadge subject="this metric" summary={summaries[rule.selector.metric]} pending={isPending} />
              </TableCell>
            ) : null}
            <TableCell className="hidden text-right sm:table-cell">
              <RuleImpact rule={rule} totalSeries={totalSeries} />
            </TableCell>
            <TableCell>
              <RuleActions rule={rule} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Rules for the signal in view; a `#logrules=` share link opens the logs side. */
export function RulesPage() {
  const signal = useSignal()
  const { hash } = useLocation()
  // A share link picks its own signal: a metrics link opens metric rules even while Logs is selected.
  const metricsLink = new URLSearchParams(hash.replace(/^#/, "")).has(SHARE_HASH_KEY)
  return hasLogShareHash(hash) || (signal === "logs" && !metricsLink) ? <LogRulesPage /> : <MetricRulesPage />
}

function MetricRulesPage() {
  const rules = useAppStore((state) => state.rules)
  const totalSeries = useAppStore((state) => state.snapshot?.totalSeries ?? 0)
  const setRuleStatus = useAppStore((state) => state.setRuleStatus)
  const clearRules = useAppStore((state) => state.clearRules)
  const savings = useSavings()
  const age = useSnapshotAge()
  const { format: formatCost } = useCost()
  const { refresh, isPending: refreshing } = useRefreshSnapshot()
  const { adaptive } = useMetricsTarget()
  const [params, setParams] = useSearchParams()
  const [output, setOutput] = React.useState<ExportOutput | null>(null)
  // Recommendations come from Adaptive Metrics: Grafana Cloud only.
  const view: View = adaptive && params.get("view") === "recommendations" ? "recommendations" : "rules"
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === null) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true }
    )

  const byStatus = React.useMemo(() => {
    const groups: Record<RuleStatus, Rule[]> = { active: [], proposed: [], rejected: [] }
    for (const rule of rules) groups[rule.status].push(rule)
    return groups
  }, [rules])
  const exp = useMetricsExport(byStatus.active, output)

  const requested = params.get("tab")
  const tab: RuleStatus = isRuleStatus(requested) ? requested : byStatus.proposed.length ? "proposed" : "active"
  const proposedIds = byStatus.proposed.map((rule) => rule.id)
  const cost = formatCost(savings.savedSeries)

  return (
    <Page>
      <PageHeader
        title="Your plan"
        eyebrow={<SignalBadge signal="metrics" />}
        actions={
          view === "rules" ? (
            <>
              <ShareMenu rules={rules} />
              <ImportDialog />
              {byStatus.active.length ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost">
                      <TrashIcon data-icon="inline-start" />
                      Clear
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove all active rules?</AlertDialogTitle>
                      <AlertDialogDescription>Pending proposals are kept. This only affects this browser.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={clearRules}>
                        Remove {byStatus.active.length} rules
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </>
          ) : null
        }
      />
      {adaptive ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            aria-label="Rules view"
            value={view}
            onValueChange={(value) => setParam("view", value === "rules" ? null : value)}
            options={[
              { value: "rules", label: "Plan", count: rules.length || undefined },
              { value: "recommendations", label: "Recommendations" },
            ]}
          />
          {view === "recommendations" ? (
            <SignalBadge signal="metrics" className="h-6 px-2.5 text-xs">
              Adaptive Metrics
            </SignalBadge>
          ) : null}
        </div>
      ) : null}
      {view === "recommendations" ? (
        <AdaptiveMetrics />
      ) : (
        <>
          <SharedRulesBanner />
          <RuleDestinationStep />
          <PlanHeader
            saving={<AnimatedNumber value={savings.savedSeries} format={(value) => formatDelta(-value)} />}
            unit="series"
            estimate={savings.isEstimate}
            cost={cost}
            percent={savings.percent}
            meta={
              <span title={age?.capturedAt.toLocaleString()} className={age?.stale ? "text-brand-ink" : undefined}>
                for {METRICS_DESTINATIONS[exp.destination].label} · {exp.meta}
              </span>
            }
            detail={
              <>
                {byStatus.active.length} active rule{byStatus.active.length === 1 ? "" : "s"} ·{" "}
                <AnimatedNumber value={savings.percent} format={(value) => `${value.toFixed(1)}%`} /> of {formatNumber(totalSeries)}{" "}
                <Term id="activeSeries">series</Term>
              </>
            }
            actions={<MetricPlanActions exp={exp} onOutput={setOutput} />}
          >
            {exp.blocked.length ? (
              <p className="text-xs text-brand-ink">
                {exp.blocked.length === 1 ? "1 label drop needs a choice" : `${exp.blocked.length} label drops need a choice`}: pick below.
              </p>
            ) : null}
            {age?.stale ? (
              <Button size="xs" variant="outline" className="self-start" disabled={refreshing} onClick={refresh}>
                <ArrowClockwiseIcon data-icon="inline-start" />
                Refresh the {age.label.replace(" ago", "")}-old snapshot
              </Button>
            ) : null}
          </PlanHeader>
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                  aria-label="Rule status"
                  value={tab}
                  onValueChange={(value) => setParam("tab", value)}
                  options={TABS.map((status) => ({
                    value: status,
                    label: TAB_LABEL[status],
                    count: byStatus[status].length }))}
                />
                {tab === "proposed" && proposedIds.length > 1 ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setRuleStatus(proposedIds, "rejected")}>
                      <XIcon data-icon="inline-start" />
                      Reject all
                    </Button>
                    <AcceptAllButton rules={byStatus.proposed} onAccept={(ids) => setRuleStatus(ids, "active")} />
                  </div>
                ) : null}
              </div>
              <Card>
                <CardContent>
                  <RulesTable rules={byStatus[tab]} allRules={rules} status={tab} totalSeries={totalSeries} />
                </CardContent>
              </Card>
            </div>
            <div className="min-w-0">
              <ExportCard exp={exp} onOutput={setOutput} />
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
