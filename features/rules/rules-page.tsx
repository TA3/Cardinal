import * as React from "react"
import { ChartLineDownIcon, ShieldCheckIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { Link, useLocation, useSearchParams } from "react-router"

import { metricPath, paths } from "@/app/paths"
import { CostText } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { AnimatedNumber } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { MergeNote, RuleActions, RuleDescription, RuleImpact, RuleOriginBadge } from "@/components/rule-parts"
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
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdaptiveMetrics } from "@/features/adaptive/adaptive-metrics"
import { AcceptAllButton } from "@/features/rules/accept-all"
import { ExportCard } from "@/features/rules/export-card"
import { ImportDialog } from "@/features/rules/import-dialog"
import { LogRulesPage } from "@/features/rules/log-rules-page"
import { hasLogShareHash } from "@/features/rules/log-share"
import { SharedRulesBanner, ShareMenu } from "@/features/rules/share"
import { Term } from "@/features/rules/term"
import { useUsageSummaries } from "@/features/rules/usage"
import { useSavings, useSnapshotAge } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
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
  active: { title: "No rules yet", text: "Drop metrics or labels while exploring, import your current rules, or let an agent propose some." },
  proposed: { title: "Nothing to review", text: "Rules suggested by an agent or Adaptive Metrics land here for your approval." },
  rejected: { title: "Nothing rejected", text: "Rejected proposals are kept here in case you change your mind." } }

function RulesTable({ rules, allRules, status, totalSeries }: { rules: Rule[]; allRules: Rule[]; status: RuleStatus; totalSeries: number }) {
  const metrics = React.useMemo(() => rules.map((rule) => rule.selector.metric), [rules])
  const { summaries, isPending } = useUsageSummaries(metrics, status !== "rejected" && rules.length > 0)
  if (rules.length === 0) {
    return (
      <EmptyState icon={ShieldCheckIcon} title={EMPTY_COPY[status].title} description={EMPTY_COPY[status].text}>
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
          <TableHead className="text-right">Saves</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell className="max-w-0 min-w-56 whitespace-normal">
              <Link
                to={metricPath(rule.selector.metric)}
                title={rule.selector.metric}
                className="block rounded-lg hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <RuleDescription rule={rule} supersededBy={rule.status === "active" ? shadowedBy(rule, allRules) : undefined} />
              </Link>
              {rule.rationale ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{rule.rationale}</p> : null}
              <MergeNote rule={rule} className="mt-1.5" />
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <RuleOriginBadge rule={rule} />
            </TableCell>
            {status !== "rejected" ? (
              <TableCell className="hidden sm:table-cell">
                <UsedBadge subject="this metric" summary={summaries[rule.selector.metric]} pending={isPending} />
              </TableCell>
            ) : null}
            <TableCell className="text-right">
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
  const [params, setParams] = useSearchParams()
  const view: View = params.get("view") === "recommendations" ? "recommendations" : "rules"
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

  const requested = params.get("tab")
  const tab: RuleStatus = isRuleStatus(requested) ? requested : byStatus.proposed.length ? "proposed" : "active"
  const proposedIds = byStatus.proposed.map((rule) => rule.id)

  return (
    <Page>
      <PageHeader
        title="Rules"
        eyebrow={<SignalBadge signal="metrics" />}
        description={
          view === "rules"
            ? "Everything you plan to cut. Review proposals, check the impact, then export or apply."
            : "Suggestions from your backend's adaptive telemetry. Propose them into Rules to review."
        }
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label="Rules view"
          value={view}
          onValueChange={(value) => setParam("view", value === "rules" ? null : value)}
          options={[
            { value: "rules", label: "Rules", count: rules.length || undefined },
            { value: "recommendations", label: "Recommendations" },
          ]}
        />
        {view === "recommendations" ? (
          <SignalBadge signal="metrics" className="h-6 px-2.5 text-xs">
            Adaptive Metrics
          </SignalBadge>
        ) : null}
      </div>
      {view === "recommendations" ? (
        <AdaptiveMetrics />
      ) : (
        <>
          <SharedRulesBanner />
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-4">
              <Frame>
                <FrameHeader
                  icon={ChartLineDownIcon}
                  title="Projected reduction"
                  meta={
                    age ? (
                      <span title={age.capturedAt.toLocaleString()} className={age.stale ? "text-brand-ink" : undefined}>
                        from active rules · snapshot {age.label}
                      </span>
                    ) : (
                      "from active rules"
                    )
                  }
                />
                <FrameWell className="flex flex-col gap-3 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-2xl font-medium tracking-tight tabular-nums">
                      {savings.isEstimate ? "~" : ""}
                      <AnimatedNumber value={savings.savedSeries} format={(value) => formatDelta(-value)} />
                      <span className="ml-1.5 text-sm font-normal text-muted-foreground">series</span>
                    </span>
                    <span className="flex items-baseline gap-2 text-sm text-muted-foreground tabular-nums">
                      <CostText series={savings.savedSeries} className="text-sm" />
                      <span>
                        <AnimatedNumber value={savings.percent} format={(value) => `${value.toFixed(1)}%`} /> of {formatNumber(totalSeries)}{" "}
                        <Term id="activeSeries">active series</Term>
                      </span>
                    </span>
                  </div>
                  <Progress value={savings.percent} className="h-1.5" />
                  {savings.isEstimate ? (
                    <p className="text-xs text-muted-foreground">Some rules haven't been measured yet; ~ marks an estimate.</p>
                  ) : null}
                  {age?.stale ? (
                    <p className="text-xs text-brand-ink">
                      The snapshot is {age.label.replace(" ago", "")} old; refresh it before trusting these numbers.
                    </p>
                  ) : null}
                </FrameWell>
              </Frame>
              <div className="flex flex-col gap-3">
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
            </div>
            <div className="min-w-0">
              <ExportCard rules={byStatus.active} />
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
