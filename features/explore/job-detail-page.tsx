import * as React from "react"
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  DotsThreeIcon,
  FileTextIcon,
  FunnelSimpleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  ScissorsIcon,
  TagIcon,
} from "@phosphor-icons/react"
import { useParams } from "react-router"

import { CodeBlock } from "@/components/code-block"
import { useCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Page, PageHeader } from "@/components/page"
import { PlanBar } from "@/components/plan-bar"
import { RequireSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { OwnerBadge } from "@/features/attribution/owner-badge"
import { useJobOwners } from "@/features/attribution/use-attribution"
import { JobLabelDialog } from "@/features/explore/job-label-dialog"
import { MetricWorkDialog } from "@/features/explore/metric-work-dialog"
import { useJobWork } from "@/features/explore/use-job-work"
import { KeepListDialog } from "@/features/plan/keep-list-dialog"
import { addJobCut, removeKeepList } from "@/features/plan/use-cut-plan"
import { cacheDrilldownFor, useConnection } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { runWithConcurrency } from "@/lib/core/concurrency"
import type { JobWork, MetricWork } from "@/lib/core/job-work"
import { jobFromParam, jobLabel } from "@/lib/core/jobs"
import type { MetricRule } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import { buildPromptDataForJob, generateAIPrompt } from "@/lib/dashboard/prompt"
import type { JobDrilldownResponse } from "@/lib/prometheus/types"
import { fetchMetricDrilldown } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// A job, worked through by hand. On top, what the job-wide cuts do and how
// far along it is; below, every metric with what the plan does to it. A
// metric opens a dialog with its options, one tool at a time.

function DashboardPromptDialog({ job, drilldown }: { job: string; drilldown: JobDrilldownResponse }) {
  const connection = useConnection()
  const [open, setOpen] = React.useState(false)
  const [prompt, setPrompt] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function generate() {
    if (!connection) return
    setOpen(true)
    setPending(true)
    try {
      const cached = useAppStore.getState().drilldowns
      const missing = drilldown.metrics.slice(0, 20).map((row) => row.metric).filter((metric) => !cached[metric])
      const fetched = await runWithConcurrency(missing, (metric) => fetchMetricDrilldown(connection, metric).catch(() => null), 4)
      for (const row of fetched) if (row) cacheDrilldownFor(connection, row)
      setPrompt(generateAIPrompt(buildPromptDataForJob(drilldown, useAppStore.getState().drilldowns, 20), { job }))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="More actions for this job">
            <DotsThreeIcon data-icon="inline-start" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem disabled={!connection} onSelect={() => void generate()}>
            <FileTextIcon />
            Grafana dashboard prompt
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Dashboard prompt for {jobLabel(job)}</DialogTitle>
            <DialogDescription>Paste into an AI assistant to draft a Grafana dashboard for this job's metrics.</DialogDescription>
          </DialogHeader>
          {pending || !prompt ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Reading label structure of the top metrics…
            </div>
          ) : (
            <CodeBlock code={prompt} maxHeight="max-h-[60svh]" />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function JobDetail({ job, snapshot }: { job: string; snapshot: Snapshot }) {
  const { work, used, keepList, selfMetrics, loading, error } = useJobWork(job, snapshot)
  const summary = snapshot.jobs.find((item) => item.job === job)
  const owners = useJobOwners()
  const [open, setOpen] = React.useState<{ queue: string[]; index: number } | null>(null)
  const byMetric = React.useMemo(() => new Map(work.metrics.map((item) => [item.metric, item])), [work.metrics])
  const drilldown = React.useMemo<JobDrilldownResponse>(
    () => ({
      job,
      totalSeries: work.seriesCount,
      metrics: work.metrics.map((item) => ({
        job,
        metric: item.metric,
        seriesCount: item.seriesCount,
        percentageOfTotal: work.seriesCount ? (item.seriesCount / work.seriesCount) * 100 : 0,
      })),
    }),
    [job, work]
  )

  const share = summary ? summary.percentageOfTotal : 0
  return (
    <Page className="pb-24">
      <PageHeader
        eyebrow={
          <>
            <Badge variant="outline">Job</Badge>
            <OwnerBadge owners={owners?.get(job)} />
          </>
        }
        title={jobLabel(job)}
        description={
          work.metrics.length
            ? `${formatNumber(work.seriesCount)} series (${share < 1 ? share.toFixed(1) : Math.round(share)}% of all) across ${formatNumber(work.metrics.length)} metrics. Go through them and cut what you don't need.`
            : job === ""
              ? "Series that have no job label."
              : "Not in the current snapshot."
        }
        actions={work.metrics.length ? <DashboardPromptDialog job={job} drilldown={drilldown} /> : null}
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load this job</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <Skeleton className="h-40 rounded-[26px]" />
      ) : work.metrics.length ? (
        <>
          <JobSummary snapshot={snapshot} work={work} used={used} keepList={keepList} selfMetrics={selfMetrics} />
          <Worklist work={work} used={used} onOpen={(queue, index) => setOpen({ queue, index })} />
        </>
      ) : null}
      <MetricWorkDialog
        job={job}
        queue={open?.queue ?? []}
        index={open?.index ?? null}
        work={byMetric}
        used={used}
        onIndex={(index) => setOpen((current) => (current ? { ...current, index } : current))}
        onClose={() => setOpen(null)}
      />
      <PlanBar />
    </Page>
  )
}

function JobSummary({
  snapshot,
  work,
  used,
  keepList,
  selfMetrics,
}: {
  snapshot: Snapshot
  work: JobWork
  used: Record<string, boolean | undefined>
  keepList: ReturnType<typeof useJobWork>["keepList"]
  selfMetrics: ReturnType<typeof useJobWork>["selfMetrics"]
}) {
  const { format } = useCost()
  const live = Boolean(useConnection())
  const [dialog, setDialog] = React.useState<"keep" | "label" | null>(null)
  const after = Math.max(0, work.seriesCount - work.savedSeries)
  const percent = work.seriesCount ? (work.savedSeries / work.seriesCount) * 100 : 0
  const cost = format(work.savedSeries)
  const total = work.metrics.length

  return (
    <Frame>
      <FrameWell className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">With your cuts</span>
            <span className="text-2xl font-medium tracking-tight tabular-nums">
              {work.savedSeries ? (
                <>
                  {formatNumber(work.seriesCount)}
                  <span className="text-muted-foreground"> → </span>
                  {work.unmeasured ? "~" : ""}
                  {formatNumber(after)}
                  <span className="ml-2 text-sm font-medium text-brand-ink">
                    −{percent < 1 ? percent.toFixed(1) : Math.round(percent)}%{cost ? ` · ${cost}` : ""}
                  </span>
                </>
              ) : (
                <>
                  {formatNumber(work.seriesCount)} <span className="text-sm font-normal text-muted-foreground">series, nothing cut yet</span>
                </>
              )}
            </span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(work.done)} of {formatNumber(total)} metrics done
          </span>
        </div>
        <Progress value={total ? (work.done / total) * 100 : 0} aria-label="Metrics done" className="h-1.5" />
      </FrameWell>
      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2.5 pb-2">
        {keepList ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setDialog("keep")}>
                <FunnelSimpleIcon data-icon="inline-start" />
                {keepList.rule ? `Keep-list · keeps ${formatNumber(keepList.rule.metrics.length)}` : "Keep only some metrics"}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Say what stays and drop the rest, including metrics a new exporter version adds later.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {live ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setDialog("label")}>
                <TagIcon data-icon="inline-start" />
                Remove a label everywhere
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">Remove one label, like a pod hash, from every metric of this job.</TooltipContent>
          </Tooltip>
        ) : null}
        {selfMetrics && selfMetrics.state !== "active" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => addJobCut(snapshot, selfMetrics)}>
                <GearSixIcon data-icon="inline-start" />
                Drop the exporter's own metrics
                <span className="text-muted-foreground tabular-nums">{formatDelta(-selfMetrics.savedSeries)}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {selfMetrics.metrics.length} go_*, process_* and promhttp_* metrics describe the exporter process, not what it
              monitors.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {keepList && dialog === "keep" ? (
        <KeepListDialog
          open
          onOpenChange={(next) => setDialog(next ? "keep" : null)}
          cut={keepList}
          used={used}
          onConfirm={(keep) => addJobCut(snapshot, keepList, keep)}
          onRemove={() => removeKeepList(keepList)}
        />
      ) : null}
      <JobLabelDialog open={dialog === "label"} onOpenChange={(next) => setDialog(next ? "label" : null)} job={work.job} work={work} />
    </Frame>
  )
}

type Show = "open" | "done" | "all"

/** What the plan does to a metric, in a few words. */
function stateText(item: MetricWork, used: boolean | undefined) {
  if (item.state === "dropped") return item.byKeepList ? "dropped by the keep-list" : "dropped"
  if (item.state === "kept") return "kept as is"
  if (item.state === "cut") return item.rules.map(ruleWords).join(" · ")
  if (used === false) return "nothing reads it"
  if (used === true) return "in use"
  return null
}

function ruleWords(rule: MetricRule) {
  switch (rule.kind) {
    case "drop_metric":
      return "dropped"
    case "drop_labels":
      return `without ${rule.labels.join(", ")}`
    case "drop_series":
      return `some ${rule.match.label} series dropped`
    case "keep_buckets":
      return `${rule.buckets.length} buckets`
    case "group_values":
      return `${rule.label} grouped`
  }
}

function StateIcon({ state }: { state: MetricWork["state"] }) {
  const className = "size-4 shrink-0"
  if (state === "dropped") return <ProhibitIcon className={cn(className, "text-destructive")} aria-hidden />
  if (state === "cut") return <ScissorsIcon className={cn(className, "text-brand-ink")} aria-hidden />
  if (state === "kept") return <CheckCircleIcon className={cn(className, "text-muted-foreground")} aria-hidden />
  return <CircleIcon className={cn(className, "text-muted-foreground/40")} aria-hidden />
}

function Worklist({
  work,
  used,
  onOpen,
}: {
  work: JobWork
  used: Record<string, boolean | undefined>
  onOpen: (queue: string[], index: number) => void
}) {
  const left = work.metrics.length - work.done
  const [show, setShow] = React.useState<Show>(left > 0 ? "open" : "all")
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const rows = work.metrics.filter(
    (item) =>
      (show === "all" || (show === "open") === (item.state === "open")) && (!needle || item.metric.toLowerCase().includes(needle))
  )
  const open = (index: number) =>
    onOpen(
      rows.map((item) => item.metric),
      index
    )
  const { rowProps } = useRowCursor({ count: rows.length, resetKey: `${show}\u0000${needle}`, onOpen: open })

  return (
    <Frame>
      <FrameHeader
        title="Metrics"
        meta={<span className="hidden sm:inline">largest first · open one to see what you can do</span>}
        action={
          <SegmentedControl
            size="sm"
            className="shrink-0"
            aria-label="Which metrics to show"
            value={show}
            onValueChange={setShow}
            options={[
              { value: "open", label: `To do ${formatNumber(left)}` },
              { value: "done", label: `Done ${formatNumber(work.done)}` },
              { value: "all", label: "All" },
            ]}
          />
        }
      />
      <FrameWell className="flex flex-col gap-2 px-2 py-2">
        <label className="mx-1 flex h-8 items-center gap-1.5 rounded-full border border-input bg-background px-3 text-sm sm:max-w-xs">
          <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter metrics"
            aria-label="Filter metrics"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={needle ? MagnifyingGlassIcon : CheckCircleIcon}
            title={needle ? "No matching metric" : show === "open" ? "Every metric is done" : "Nothing done yet"}
            description={
              needle
                ? `Nothing matches “${query}”.`
                : show === "open"
                  ? "Each metric is cut, dropped or kept as is."
                  : "Open a metric to cut it, or keep it as is."
            }
          >
            {!needle && show === "open" ? (
              <Button size="sm" variant="outline" onClick={() => setShow("all")}>
                Show all
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <ul className="flex flex-col">
            {rows.map((item, index) => {
              const text = stateText(item, used[item.metric])
              return (
                <li key={item.metric}>
                  <button
                    type="button"
                    {...rowProps(index)}
                    onClick={() => open(index)}
                    className={cn(
                      "group/row flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/50",
                      CURSOR_ROW_CLASS,
                      "data-[cursor=true]:bg-background/70"
                    )}
                  >
                    <StateIcon state={item.state} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("truncate font-mono text-[13px]", item.state === "dropped" && "text-muted-foreground line-through decoration-foreground/20")}>
                        {item.metric}
                      </span>
                      {text ? (
                        <span
                          className={cn(
                            "truncate text-[11px]",
                            item.state === "open" && used[item.metric] === false ? "text-brand-ink" : "text-muted-foreground"
                          )}
                        >
                          {text}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end tabular-nums">
                      <span className="text-sm">{formatNumber(item.seriesCount)}</span>
                      {item.savedSeries > 0 ? (
                        <span className="text-[11px] text-brand-ink">{formatDelta(-item.savedSeries)}</span>
                      ) : item.unmeasured ? (
                        <span className="text-[11px] text-muted-foreground">measuring…</span>
                      ) : null}
                    </span>
                    <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/row:translate-x-0.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </FrameWell>
    </Frame>
  )
}

export function JobDetailPage() {
  const params = useParams()
  const job = jobFromParam(params["*"] ?? "")
  return <RequireSnapshot>{(snapshot) => <JobDetail key={job} job={job} snapshot={snapshot} />}</RequireSnapshot>
}
