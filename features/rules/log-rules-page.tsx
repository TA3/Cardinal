import * as React from "react"
import { ChartLineDownIcon, ShieldCheckIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { Link, useSearchParams } from "react-router"

import { paths } from "@/app/paths"
import { CostText } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { AnimatedNumber } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdaptiveLogs } from "@/features/adaptive/adaptive-logs"
import { LogExportCard, useLegacyExemptionsMigration } from "@/features/rules/log-export-card"
import { LogImportDialog } from "@/features/rules/log-import-dialog"
import { LogAcceptAllButton, LogRuleActions, LogRuleDescription, LogRuleImpactCell, LogRuleOriginBadge } from "@/features/rules/log-rule-parts"
import { LogShareMenu, SharedLogRulesBanner } from "@/features/rules/log-share"
import { useLogUsageSummaries } from "@/features/rules/log-usage"
import { Term } from "@/features/rules/term"
import { useLogsSnapshotAge } from "@/hooks/use-cardinality"
import { formatBytes } from "@/lib/core/bytes"
import { computeLogSavings } from "@/lib/core/logs/impact"
import { logRuleProtectedBy, logRuleShadowedBy } from "@/lib/core/logs/rules"
import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogRule, LogRuleStatus } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// The Rules page under Logs: the same Active / Proposed / Rejected workflow,
// projected reduction and export as metrics, over `logRules`.

const TABS: readonly LogRuleStatus[] = ["active", "proposed", "rejected"]
const TAB_LABEL: Record<LogRuleStatus, string> = { active: "Active", proposed: "Proposed", rejected: "Rejected" }

function isStatus(value: string | null): value is LogRuleStatus {
  return TABS.includes(value as LogRuleStatus)
}

const EMPTY_COPY: Record<LogRuleStatus, { title: string; text: string }> = {
  active: { title: "No log rules yet", text: "Drop noisy streams or lines, move labels to structured metadata, import your pipeline, or let an agent propose some." },
  proposed: { title: "Nothing to review", text: "Log rules suggested by an agent, a share link or Adaptive Logs land here for your approval." },
  rejected: { title: "Nothing rejected", text: "Rejected proposals are kept here in case you change your mind." },
}

function LogRulesTable({
  rules,
  allRules,
  status,
  rangeDays,
  totalBytes,
}: {
  rules: LogRule[]
  allRules: LogRule[]
  status: LogRuleStatus
  rangeDays: number
  totalBytes: number
}) {
  const { summaries, isPending } = useLogUsageSummaries(rules, status !== "rejected")
  if (rules.length === 0) {
    return (
      <EmptyState icon={ShieldCheckIcon} title={EMPTY_COPY[status].title} description={EMPTY_COPY[status].text}>
        {status === "active" ? (
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link to={paths.logStreams}>Explore streams</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.agent}>Use an agent</Link>
            </Button>
          </div>
        ) : null}
      </EmptyState>
    )
  }
  const active = allRules.filter((rule) => rule.status === "active")
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
            <TableCell className="max-w-0 min-w-36 whitespace-normal sm:min-w-56">
              <LogRuleDescription
                rule={rule}
                supersededBy={rule.status === "active" ? logRuleShadowedBy(rule, active) : undefined}
                protectedBy={rule.status === "active" ? logRuleProtectedBy(rule, active) : undefined}
              />
              {rule.rationale ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{rule.rationale}</p> : null}
              {rule.impact?.note ? <p className="mt-1 hidden text-xs text-muted-foreground/80 sm:block">{rule.impact.note}</p> : null}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <LogRuleOriginBadge rule={rule} />
            </TableCell>
            {status !== "rejected" ? (
              <TableCell className="hidden sm:table-cell">
                <UsedBadge subject="these streams" summary={summaries[rule.id]} pending={isPending && rule.kind !== "keep"} />
              </TableCell>
            ) : null}
            <TableCell className="text-right">
              <LogRuleImpactCell rule={rule} rangeDays={rangeDays} totalBytes={totalBytes} />
            </TableCell>
            <TableCell>
              <LogRuleActions rule={rule} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ProjectedReduction({ rules }: { rules: LogRule[] }) {
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const age = useLogsSnapshotAge()
  const savings = React.useMemo(() => computeLogSavings(rules, snapshot), [rules, snapshot])
  const rangeDays = snapshot ? LOGS_RANGE_SECONDS[snapshot.range] / 86400 : 1
  const perDay = savings.savedBytes / rangeDays
  const totalPerDay = snapshot ? snapshot.totals.bytes / rangeDays : 0
  const approx = savings.isEstimate ? "~" : ""
  return (
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
        {snapshot ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-2xl font-medium tracking-tight tabular-nums">
                {approx}
                <AnimatedNumber value={perDay} format={(value) => (value > 0 ? `−${formatBytes(value)}` : "0 B")} />
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  <Term id="logVolume">ingest</Term> per day
                </span>
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground tabular-nums">
                <CostText bytes={perDay} per="day" className="text-sm" />
                <span>
                  <AnimatedNumber value={savings.percent} format={(value) => `${value.toFixed(1)}%`} /> of {formatBytes(totalPerDay)}/day
                </span>
              </span>
            </div>
            <Progress value={savings.percent} className="h-1.5" />
            <p className="text-xs text-muted-foreground tabular-nums">
              {savings.savedStreams > 0 ? (
                <>
                  {approx}−{savings.savedStreams.toLocaleString()} <Term id="logStream">streams</Term> ({savings.streamsPercent.toFixed(1)}% of{" "}
                  {snapshot.totals.streams.toLocaleString()})
                </>
              ) : (
                <>No stream reduction from active rules. Label moves and drops cut streams, not bytes.</>
              )}
            </p>
            {savings.isEstimate ? (
              <p className="text-xs text-muted-foreground">
                Some rules are estimates (levels, sampling, overlapping selectors) or not measured yet; ~ marks an estimate.
              </p>
            ) : null}
            {age?.stale ? (
              <p className="text-xs text-brand-ink">The logs snapshot is {age.label.replace(" ago", "")} old; refresh it before trusting these numbers.</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Take a logs snapshot to measure what these rules save.{" "}
            <Link to={paths.logs} className="text-brand-ink hover:underline">
              Open the logs overview
            </Link>
          </p>
        )}
      </FrameWell>
    </Frame>
  )
}

export function LogRulesPage() {
  useLegacyExemptionsMigration()
  const rules = useAppStore((state) => state.logRules)
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const setLogRuleStatus = useAppStore((state) => state.setLogRuleStatus)
  const clearLogRules = useAppStore((state) => state.clearLogRules)
  const [params, setParams] = useSearchParams()
  const view = params.get("view") === "recommendations" ? "recommendations" : "rules"
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
    const groups: Record<LogRuleStatus, LogRule[]> = { active: [], proposed: [], rejected: [] }
    for (const rule of rules) groups[rule.status].push(rule)
    return groups
  }, [rules])

  const requested = params.get("tab")
  const tab: LogRuleStatus = isStatus(requested) ? requested : byStatus.proposed.length ? "proposed" : "active"
  const proposedIds = byStatus.proposed.map((rule) => rule.id)
  const rangeDays = snapshot ? LOGS_RANGE_SECONDS[snapshot.range] / 86400 : 1

  return (
    <Page>
      <PageHeader
        title="Rules"
        eyebrow={<SignalBadge signal="logs" />}
        description={
          view === "rules"
            ? "Everything you plan to cut from Loki. Review proposals, check the impact, then export or apply."
            : "Suggestions from Grafana Cloud Adaptive Logs. Propose them into Rules to review."
        }
        actions={
          view === "rules" ? (
            <>
              <LogShareMenu rules={rules} />
              <LogImportDialog />
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
                      <AlertDialogTitle>Remove all active log rules?</AlertDialogTitle>
                      <AlertDialogDescription>Pending proposals are kept. This only affects this browser.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={clearLogRules}>
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
          <SignalBadge signal="logs" className="h-6 px-2.5 text-xs">
            Adaptive Logs
          </SignalBadge>
        ) : null}
      </div>
      {view === "recommendations" ? (
        <AdaptiveLogs />
      ) : (
        <>
          <SharedLogRulesBanner />
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-4">
              <ProjectedReduction rules={rules} />
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SegmentedControl
                    aria-label="Rule status"
                    value={tab}
                    onValueChange={(value) => setParam("tab", value)}
                    options={TABS.map((status) => ({ value: status, label: TAB_LABEL[status], count: byStatus[status].length }))}
                  />
                  {tab === "proposed" && proposedIds.length > 1 ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setLogRuleStatus(proposedIds, "rejected")}>
                        <XIcon data-icon="inline-start" />
                        Reject all
                      </Button>
                      <LogAcceptAllButton rules={byStatus.proposed} />
                    </div>
                  ) : null}
                </div>
                <Card>
                  <CardContent>
                    <LogRulesTable
                      rules={byStatus[tab]}
                      allRules={rules}
                      status={tab}
                      rangeDays={rangeDays}
                      totalBytes={snapshot?.totals.bytes ?? 0}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
            <div className="min-w-0">
              <LogExportCard rules={byStatus.active} />
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
