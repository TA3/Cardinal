import * as React from "react"
import {
  ArrowRightIcon,
  CheckIcon,
  FunnelSimpleIcon,
  GearSixIcon,
  PlusIcon,
  ScissorsIcon,
  SigmaIcon,
  TagSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { Link } from "react-router"

import { jobPath, metricPath, paths, rulesPath } from "@/app/paths"
import { useCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Reveal, Stagger } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RiskBadge } from "@/components/risk-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { PlanBar } from "@/components/plan-bar"
import { Connect, Learning } from "@/features/inbox/inbox-page"
import { SetupChecklist } from "@/features/inbox/setup-checklist"
import { KeepListDialog } from "@/features/plan/keep-list-dialog"
import { LogsPlan } from "@/features/plan/logs-plan"
import {
  cutTitle,
  removeKeepList,
  useAddCut,
  useCutPlan,
} from "@/features/plan/use-cut-plan"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import type { JobPlan, PlanCut, UsageCoverage } from "@/lib/core/cut-plan"
import { histogramFamily } from "@/lib/core/families"
import { jobLabel } from "@/lib/core/jobs"
import type { Snapshot } from "@/lib/core/snapshot"
import { selectHasLogs, useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// The Plan: what to cut, job by job. A job (usually one exporter) is decided
// as a whole: keep the metrics something reads, drop the exporter's own
// runtime metrics, trim what is too fine. Every cut says what it does and
// why in plain words; Add puts it straight into the rules Cardinal exports.

export function PlanPage() {
  const snapshot = useAppStore((state) => state.snapshot)
  const logsSnapshot = useAppStore((state) => state.logsSnapshot)
  const hasLogs = useAppStore(selectHasLogs)
  const logs = hasLogs ? logsSnapshot : null

  return (
    <Page className="pb-24">
      {snapshot ? (
        <MetricsPlan snapshot={snapshot} />
      ) : (
        <PageHeader
          title="Plan"
          description="Find the metrics, labels and log lines you pay for but don't use, and cut them safely."
        />
      )}
      <Stagger className="flex flex-col gap-4">
        {!snapshot && !logs ? (
          <Reveal>
            <Connect />
          </Reveal>
        ) : null}
        {logs ? (
          <Reveal>
            <LogsPlan snapshot={logs} />
          </Reveal>
        ) : null}
        {snapshot || logs ? (
          <Reveal>
            <Learning />
          </Reveal>
        ) : null}
      </Stagger>
      <PlanBar />
    </Page>
  )
}

function MetricsPlan({ snapshot }: { snapshot: Snapshot }) {
  const { jobs, coverage, used, loading, impacts } = useCutPlan(snapshot)
  const add = useAddCut(snapshot, impacts)
  const { format } = useCost()
  const open = jobs.reduce((sum, job) => sum + job.openSavings, 0)
  const cost = format(open)
  const quiet =
    snapshot.jobs.length - jobs.filter((job) => job.job !== null).length

  return (
    <>
      <PageHeader
        title="Plan"
        status={
          open > 0 ? (
            <span className="tabular-nums">
              up to {formatDelta(-open)} series{cost ? ` · ${cost}` : ""}
            </span>
          ) : null
        }
        description="What to cut, job by job. Add what you agree with; Cardinal writes the config."
      />
      <SetupChecklist />
      <CoverageNote coverage={coverage} />
      {loading && jobs.length === 0 ? (
        <PlanSkeleton />
      ) : jobs.length === 0 ? (
        <Frame>
          <FrameWell>
            <EmptyState
              compact
              title="Nothing obvious to cut"
              description="No unused metrics, ID-like labels, heavy histograms or exporter runtime metrics worth a rule."
            >
              <Button asChild variant="outline" size="sm">
                <Link to={paths.explore}>Explore metrics</Link>
              </Button>
            </EmptyState>
          </FrameWell>
        </Frame>
      ) : (
        <Stagger className="flex flex-col gap-4">
          {jobs.map((job) => (
            <Reveal key={job.job ?? "\u0000across"}>
              <JobCard
                plan={job}
                metricCount={
                  snapshot.jobs.find((entry) => entry.job === job.job)
                    ?.metricCount ?? 0
                }
                totalSeries={snapshot.totalSeries}
                used={used}
                onAdd={add}
              />
            </Reveal>
          ))}
          {loading ? (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Still checking labels, histograms and churn…
            </p>
          ) : quiet > 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              {quiet} other {quiet === 1 ? "job has" : "jobs have"} nothing
              obvious to cut.{" "}
              <Link to={paths.jobs} className="text-brand-ink hover:underline">
                See all jobs
              </Link>
            </p>
          ) : null}
        </Stagger>
      )}
    </>
  )
}

/** Why the biggest cut may be missing: keep-lists need to know what dashboards and rules read. */
function CoverageNote({ coverage }: { coverage: UsageCoverage }) {
  // While the setup checklist shows, its usage step says the same thing.
  const checklist = useAppStore((state) => !state.setupDismissed)
  if (
    (coverage.rules && coverage.dashboards) ||
    (checklist && !coverage.dashboards)
  )
    return null
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm">
      <FunnelSimpleIcon
        className="mt-0.5 size-4 shrink-0 text-brand-ink"
        weight="bold"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Keep-lists need your dashboards</p>
        <p className="text-xs text-muted-foreground">
          The biggest cut for an exporter is keeping only the metrics something
          reads. Cardinal hasn't{" "}
          {coverage.dashboards
            ? "read your alerting and recording rules"
            : "seen your dashboards"}
          , so it can't tell those apart yet. Until then it only suggests cuts
          that don't depend on usage.
        </p>
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to={`${paths.settings}#grafana`}>Add usage</Link>
      </Button>
    </div>
  )
}

function PlanSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1].map((index) => (
        <Frame key={index}>
          <div className="px-3.5 py-3">
            <Skeleton className="h-4 w-40" />
          </div>
          <FrameWell className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </FrameWell>
        </Frame>
      ))}
    </div>
  )
}

function JobCard({
  plan,
  metricCount,
  totalSeries,
  used,
  onAdd,
}: {
  plan: JobPlan
  metricCount: number
  totalSeries: number
  used: Record<string, boolean | undefined>
  onAdd: ReturnType<typeof useAddCut>
}) {
  const share = totalSeries > 0 ? (plan.seriesCount / totalSeries) * 100 : 0
  const done = plan.openSavings === 0
  return (
    <Frame>
      <FrameHeader
        title={
          plan.job === null ? (
            "Across jobs"
          ) : (
            <Link
              to={jobPath(plan.job)}
              className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {jobLabel(plan.job)}
            </Link>
          )
        }
        meta={
          plan.job === null
            ? "metrics several jobs emit"
            : `${formatNumber(plan.seriesCount)} series · ${share < 1 ? share.toFixed(1) : Math.round(share)}% of all`
        }
        action={
          done ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5" aria-hidden />
              In your plan
            </span>
          ) : (
            <span className="shrink-0 text-sm font-medium text-brand-ink tabular-nums">
              {formatDelta(-plan.openSavings)}
            </span>
          )
        }
      />
      <FrameWell className="px-2 py-1">
        <ul className="flex flex-col divide-y divide-well-border">
          {plan.cuts.map((cut) => (
            <CutRow key={cut.id} cut={cut} used={used} onAdd={onAdd} />
          ))}
        </ul>
        {plan.job !== null && metricCount > 1 ? (
          <Link
            to={jobPath(plan.job)}
            className="group/link mx-2 mt-0.5 mb-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Go through all {formatNumber(metricCount)} metrics yourself
            <ArrowRightIcon className="size-3 transition-transform group-hover/link:translate-x-0.5" />
          </Link>
        ) : null}
      </FrameWell>
    </Frame>
  )
}

function CutIcon({ cut }: { cut: PlanCut }) {
  const className = "mt-0.5 size-4 shrink-0 text-muted-foreground"
  if (cut.kind === "keep_list")
    return <FunnelSimpleIcon className={className} aria-hidden />
  if (cut.kind === "self_metrics")
    return <GearSixIcon className={className} aria-hidden />
  const rule = cut.item.rule
  if (rule.kind === "drop_metric")
    return <TrashIcon className={className} aria-hidden />
  if (rule.kind === "keep_buckets")
    return <ScissorsIcon className={className} aria-hidden />
  if (cut.item.reason === "aggregate")
    return <SigmaIcon className={className} aria-hidden />
  return <TagSimpleIcon className={className} aria-hidden />
}

const mono = (text: string) => (
  <span className="font-mono text-[13px]">{text}</span>
)

/** The cut's title with metric and label names set in code type. */
function CutTitle({ cut }: { cut: PlanCut }) {
  if (cut.kind !== "opportunity") return <>{cutTitle(cut)}</>
  const { item } = cut
  const rule = item.rule
  const metric =
    item.reason === "buckets" ? (
      <Link
        to={`${paths.histograms}?family=${encodeURIComponent(histogramFamily(item.metric).base)}`}
        className="hover:underline"
      >
        {mono(item.metric)}
      </Link>
    ) : (
      <Link to={metricPath(item.metric)} className="hover:underline">
        {mono(item.metric)}
      </Link>
    )
  if (rule.kind === "drop_metric") return <>Drop {metric}</>
  if (rule.kind === "keep_buckets")
    return (
      <>
        Trim {metric} to {rule.buckets.length} buckets
      </>
    )
  if (item.reason === "aggregate")
    return (
      <>
        Sum {metric} without {mono(rule.labels.join(", "))}
      </>
    )
  return (
    <>
      Remove {mono(rule.labels.join(", "))} from {metric}
    </>
  )
}

function cutWhy(cut: PlanCut) {
  if (cut.kind === "keep_list") {
    if (cut.keep.length === 0)
      return "No dashboard or rule reads any of its metrics. Dropping them keeps up and scrape_*; removing the scrape job also saves the scrape itself."
    const own = cut.selfMetrics
      ? `, ${cut.selfMetrics} of them the exporter's own Go and process metrics`
      : ""
    return `${formatNumber(cut.drop.length)} metrics no dashboard or rule reads${own}. Metrics a new exporter version adds stay out until you keep them.`
  }
  if (cut.kind === "self_metrics") {
    return `go_*, process_* and promhttp_* describe the exporter process, not what it monitors.${cut.risk.missing === "dashboards" ? " Skip this if a panel shows the exporter's own memory or CPU." : ""}`
  }
  return cut.item.rationale
}

function CutRow({
  cut,
  used,
  onAdd,
}: {
  cut: PlanCut
  used: Record<string, boolean | undefined>
  onAdd: ReturnType<typeof useAddCut>
}) {
  const { format } = useCost()
  const [pending, setPending] = React.useState(false)
  const [reviewing, setReviewing] = React.useState(false)
  const cost = format(cut.savedSeries)
  const active = cut.state === "active"
  const add = async (keep?: string[]) => {
    setPending(true)
    try {
      await onAdd(cut, keep ? { keep } : undefined)
    } finally {
      setPending(false)
    }
  }

  return (
    <li
      className={cn("flex items-start gap-3 px-2 py-3", active && "opacity-70")}
    >
      <CutIcon cut={cut} />
      {/* Text, then saving and button: side by side from sm, stacked on phones. */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-sm font-medium break-words">
              <CutTitle cut={cut} />
            </span>
            {active ? null : <RiskBadge risk={cut.risk} />}
            {cut.state === "proposed" ? (
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground"
              >
                proposed
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{cutWhy(cut)}</p>
          {cut.kind === "keep_list" ? (
            <button
              type="button"
              onClick={() => setReviewing(true)}
              className="self-start rounded-sm text-xs font-medium text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {active
                ? "Edit the list"
                : `Review the ${formatNumber(cut.drop.length)} metrics it drops`}
            </button>
          ) : null}
          {cut.kind === "self_metrics" ? (
            <p
              className="truncate font-mono text-[11px] text-muted-foreground/80"
              title={cut.metrics.map((item) => item.metric).join(", ")}
            >
              {cut.metrics
                .slice(0, 4)
                .map((item) => item.metric)
                .join(", ")}
              {cut.metrics.length > 4
                ? `, +${cut.metrics.length - 4} more`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3 sm:contents">
          <div className="flex shrink-0 flex-col sm:items-end sm:pt-0.5">
            <span className="text-sm font-medium tabular-nums">
              {cut.estimate ? "~" : ""}
              {formatDelta(-cut.savedSeries)}
            </span>
            {cost ? (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {cost}
              </span>
            ) : null}
          </div>
          {active ? (
            <Button
              asChild
              size="xs"
              variant="ghost"
              className="w-24 shrink-0 text-muted-foreground"
            >
              <Link to={rulesPath("active")}>
                <CheckIcon data-icon="inline-start" />
                In plan
              </Link>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="w-24 shrink-0"
              disabled={pending}
              onClick={() => void add()}
              aria-label={`Add: ${cutTitle(cut)}`}
            >
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              Add
            </Button>
          )}
        </div>
      </div>
      {cut.kind === "keep_list" && reviewing ? (
        <KeepListDialog
          open={reviewing}
          onOpenChange={setReviewing}
          cut={cut}
          used={used}
          onConfirm={(keep) => void add(keep)}
          onRemove={() => removeKeepList(cut)}
        />
      ) : null}
    </li>
  )
}
