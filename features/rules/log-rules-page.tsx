import * as React from "react"
import { ShieldCheckIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { Link, useSearchParams } from "react-router"

import { paths } from "@/app/paths"
import { useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdaptiveLogs } from "@/features/adaptive/adaptive-logs"
import { LogExportCard, LogPlanActions, useLegacyExemptionsMigration, useLogsExport } from "@/features/rules/log-export-card"
import { LogImportDialog } from "@/features/rules/log-import-dialog"
import { LogAcceptAllButton, LogRuleActions, LogRuleDescription, LogRuleImpactCell, LogRuleOriginBadge } from "@/features/rules/log-rule-parts"
import { LogShareMenu, SharedLogRulesBanner } from "@/features/rules/log-share"
import { PlanHeader } from "@/features/rules/plan-header"
import { useLogUsageSummaries } from "@/features/rules/log-usage"
import { Term } from "@/features/rules/term"
import { useLogsAdaptive, useLogsSnapshotAge, useLogsTarget } from "@/hooks/use-cardinality"
import { LOGS_DESTINATIONS, type LogsExportFormat } from "@/lib/core/backend-profile"
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
  active: { title: "No log rules yet", text: "Drop noisy streams or lines while exploring, or import your pipeline." },
  proposed: { title: "Nothing to review", text: "Agent and share-link suggestions land here." },
  rejected: { title: "Nothing rejected", text: "Rejected proposals stay here." },
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
          <TableHead className="hidden text-right sm:table-cell">Saves</TableHead>
          <TableHead className="w-20 sm:w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell className="max-w-0 whitespace-normal sm:min-w-56">
              <LogRuleDescription
                rule={rule}
                supersededBy={rule.status === "active" ? logRuleShadowedBy(rule, active) : undefined}
                protectedBy={rule.status === "active" ? logRuleProtectedBy(rule, active) : undefined}
              />
              {rule.rationale ? <p className="mt-1 hidden text-xs text-muted-foreground sm:line-clamp-2">{rule.rationale}</p> : null}
              <div className="mt-1 sm:hidden [&>*]:items-start [&>*]:text-left">
                <LogRuleImpactCell rule={rule} rangeDays={rangeDays} totalBytes={totalBytes} />
              </div>
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
            <TableCell className="hidden text-right sm:table-cell">
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

function LogPlanHeader({ rules, actions }: { rules: LogRule[]; actions: React.ReactNode }) {
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const age = useLogsSnapshotAge()
  const { format: formatCost } = useBytesCost()
  const { destination } = useLogsTarget()
  const savings = React.useMemo(() => computeLogSavings(rules, snapshot), [rules, snapshot])
  const rangeDays = snapshot ? LOGS_RANGE_SECONDS[snapshot.range] / 86400 : 1
  const perDay = savings.savedBytes / rangeDays
  const totalPerDay = snapshot ? snapshot.totals.bytes / rangeDays : 0
  const active = rules.filter((rule) => rule.status === "active").length
  return (
    <PlanHeader
      saving={<AnimatedNumber value={perDay} format={(value) => (value > 0 ? `−${formatBytes(value)}` : "0 B")} />}
      unit={
        <>
          <Term id="logVolume">ingest</Term> per day
        </>
      }
      estimate={savings.isEstimate}
      cost={formatCost(perDay, "day")}
      percent={savings.percent}
      meta={
        <span title={age?.capturedAt.toLocaleString()} className={age?.stale ? "text-brand-ink" : undefined}>
          for {LOGS_DESTINATIONS[destination].label}
        </span>
      }
      detail={
        snapshot ? (
          <>
            {active} active rule{active === 1 ? "" : "s"} · <AnimatedNumber value={savings.percent} format={(value) => `${value.toFixed(1)}%`} /> of{" "}
            {formatBytes(totalPerDay)}/day
            {savings.savedStreams > 0 ? ` · −${savings.savedStreams.toLocaleString()} streams` : ""}
          </>
        ) : (
          <Link to={paths.logs} className="text-brand-ink hover:underline">
            Take a logs snapshot to measure
          </Link>
        )
      }
      actions={actions}
    />
  )
}

export function LogRulesPage() {
  useLegacyExemptionsMigration()
  const rules = useAppStore((state) => state.logRules)
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const setLogRuleStatus = useAppStore((state) => state.setLogRuleStatus)
  const clearLogRules = useAppStore((state) => state.clearLogRules)
  const [params, setParams] = useSearchParams()
  const adaptive = useLogsAdaptive()
  const [format, setFormat] = React.useState<LogsExportFormat | null>(null)
  // Recommendations come from Adaptive Logs: Grafana Cloud only.
  const view = adaptive && params.get("view") === "recommendations" ? "recommendations" : "rules"
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
  const exp = useLogsExport(byStatus.active, format)

  return (
    <Page>
      <PageHeader
        title="Your plan"
        eyebrow={<SignalBadge signal="logs" />}
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
            <SignalBadge signal="logs" className="h-6 px-2.5 text-xs">
              Adaptive Logs
            </SignalBadge>
          ) : null}
        </div>
      ) : null}
      {view === "recommendations" ? (
        <AdaptiveLogs />
      ) : (
        <>
          <SharedLogRulesBanner />
          <LogPlanHeader rules={rules} actions={<LogPlanActions exp={exp} onFormat={setFormat} />} />
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-4">
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
              <LogExportCard exp={exp} onFormat={setFormat} />
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
