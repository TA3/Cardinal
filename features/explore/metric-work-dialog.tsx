import * as React from "react"
import { ArrowLeftIcon, CaretRightIcon, ChartBarIcon, FunnelIcon, ProhibitIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { DropToggle } from "@/components/drop-toggle"
import { nextOpenIndex, useShownIndex, WorkDialog } from "@/components/work-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { InfoTip } from "@/components/info-tip"
import { IdBadge, LabelValues, useTopValues } from "@/features/explore/label-tools"
import { BucketPicker } from "@/features/rules/series-rule-forms"
import { RuleMergeControl, useLabelDropImpact, useMergeDefaults } from "@/features/rules/merge-choice"
import { DashboardLabelBadge } from "@/features/usage/dashboard-label-badge"
import { useConnection, useMetricDrilldown } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { histogramFamily } from "@/lib/core/families"
import { detectIdLike } from "@/lib/core/id-like"
import type { MetricWork } from "@/lib/core/job-work"
import { jobLabel } from "@/lib/core/jobs"
import { snapshotImpact } from "@/lib/core/savings"
import { sortUnique, type KeepMetricsRule, type MetricRule } from "@/lib/core/rules"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// One metric of a job and what can be done with it. The first view is a
// short list of options; each opens its own tool (labels, values, series,
// buckets), so only what the user picked is on screen. J and K step through
// the job's metrics without closing the dialog.

type Panel = { view: "home" } | { view: "label"; label: string } | { view: "buckets" }

export function MetricWorkDialog({
  job,
  queue,
  index,
  work,
  used,
  onIndex,
  onClose,
}: {
  job: string
  /** The metrics to step through, in order. */
  queue: string[]
  /** Position in `queue`; null when closed. */
  index: number | null
  work: Map<string, MetricWork>
  used: Record<string, boolean | undefined>
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const position = useShownIndex(index)
  const metric = queue[position]
  const item = metric === undefined ? undefined : work.get(metric)
  const setKeptAsIs = useAppStore((state) => state.setKeptAsIs)

  return (
    <WorkDialog
      open={index !== null && item !== undefined}
      position={position}
      total={queue.length}
      noun="metric"
      state={item === undefined ? undefined : item.state === "open" || item.state === "kept" ? item.state : "done"}
      onStep={(step) => onIndex(position + step)}
      onKeepAsIs={() => {
        if (!item) return
        setKeptAsIs(job, item.metric, true)
        // Then the next metric nobody decided yet, else close.
        const next = nextOpenIndex(queue, position, (name) => work.get(name)?.state === "open")
        if (next === -1) onClose()
        else onIndex(next)
      }}
      onUndoKeep={() => item && setKeptAsIs(job, item.metric, false)}
      onClose={onClose}
    >
      {item ? <MetricWorkBody key={item.metric} job={job} item={item} used={used[item.metric]} /> : null}
    </WorkDialog>
  )
}

function usageText(used: boolean | undefined) {
  if (used === true) return "read by a dashboard or rule"
  if (used === false) return "nothing reads it"
  return "usage not checked"
}

function MetricWorkBody({ job, item, used }: { job: string; item: MetricWork; used: boolean | undefined }) {
  const [panel, setPanel] = React.useState<Panel>({ view: "home" })
  const live = Boolean(useConnection())
  const home = () => setPanel({ view: "home" })

  return (
    <>
      <DialogHeader className="border-b border-border/60 p-5 pb-4">
        <DialogTitle className="pr-6 font-mono text-base break-all">{item.metric}</DialogTitle>
        <DialogDescription className="tabular-nums">
          {formatNumber(item.seriesCount)} series in job {jobLabel(job)} · {usageText(used)}
          {" · "}
          <Link to={metricPath(item.metric)} className="text-brand-ink hover:underline">
            Details
          </Link>
        </DialogDescription>
      </DialogHeader>
      <div className="overflow-y-auto p-3 sm:p-4">
        {panel.view === "home" ? (
          <Home job={job} item={item} live={live} onPanel={setPanel} />
        ) : (
          <div className="flex flex-col gap-3">
            <Button variant="ghost" size="sm" className="self-start" onClick={home}>
              <ArrowLeftIcon data-icon="inline-start" />
              All options
            </Button>
            {panel.view === "label" ? <LabelPanel job={job} item={item} label={panel.label} /> : null}
            {panel.view === "buckets" ? <BucketPicker metric={item.metric} job={job} /> : null}
          </div>
        )}
      </div>
    </>
  )
}

function Home({
  job,
  item,
  live,
  onPanel,
}: {
  job: string
  item: MetricWork
  live: boolean
  onPanel: (panel: Panel) => void
}) {
  const gone = item.state === "dropped"
  const bucket = histogramFamily(item.metric).part === "bucket"
  return (
    <div className="flex flex-col gap-4">
      {item.rules.length || item.byKeepList ? <InPlan job={job} item={item} /> : null}
      {gone ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="px-2 text-xs font-medium text-muted-foreground">What you can do</h3>
          <ul className="flex flex-col">
            <li className="flex items-center gap-3 rounded-xl px-2 py-2">
              <OptionText
                icon={ProhibitIcon}
                title="Drop the whole metric"
                description={`Removes its ${formatNumber(item.seriesCount)} series from this job.`}
              />
              <DropToggle metric={item.metric} job={job} scope="job" />
            </li>
            {bucket ? (
              <OptionButton
                icon={ChartBarIcon}
                title="Trim buckets"
                description="Keep only the buckets your queries use."
                disabled={!live}
                onClick={() => onPanel({ view: "buckets" })}
              />
            ) : null}
          </ul>
        </section>
      )}
      {gone ? null : live ? (
        <LabelList job={job} item={item} onLabel={(label) => onPanel({ view: "label", label })} />
      ) : (
        <p className="px-2 text-xs text-muted-foreground">Labels need a live connection; a pasted snapshot only counts series.</p>
      )}
    </div>
  )
}

function OptionText({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}) {
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </>
  )
}

function OptionButton({
  onClick,
  disabled,
  ...text
}: React.ComponentProps<typeof OptionText> & { onClick: () => void; disabled?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="group/option flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      >
        <OptionText {...text} />
        <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/option:translate-x-0.5" />
      </button>
    </li>
  )
}

/** What a rule does to the metric, in a few words (the metric is implied). */
function ruleText(rule: MetricRule) {
  const where = rule.selector.job === undefined ? " in every job" : ""
  switch (rule.kind) {
    case "drop_metric":
      return `Dropped${where}`
    case "drop_labels":
      return `Remove ${rule.labels.join(", ")}${rule.onMerge === "aggregate" ? " (summed)" : ""}${where}`
    case "drop_series":
      return `Drop series where ${rule.match.label} matches ${rule.match.regex}${where}`
    case "keep_buckets":
      return `Keep ${rule.buckets.length} buckets${where}`
    case "group_values":
      return `Group ${rule.label} into ${rule.groups.length + (rule.rest ? 1 : 0)} values${where}`
  }
}

function savedText(rule: MetricRule) {
  if (!rule.impact) return "measuring…"
  return `${formatDelta(-(rule.impact.seriesBefore - rule.impact.seriesAfter))}`
}

function InPlan({ job, item }: { job: string; item: MetricWork }) {
  const removeRule = useAppStore((state) => state.removeRule)
  const keepList = useAppStore((state) =>
    state.rules.find(
      (rule): rule is KeepMetricsRule =>
        rule.kind === "keep_metrics" && rule.status === "active" && rule.selector.job === job
    )
  )
  const { defaults } = useMergeDefaults(item.rules)
  const keepInList = () => {
    if (!keepList) return
    const { rules, snapshot } = useAppStore.getState()
    useAppStore.setState({
      rules: rules.map((rule) => {
        if (rule.id !== keepList.id || rule.kind !== "keep_metrics") return rule
        const next = { ...rule, metrics: sortUnique([...rule.metrics, item.metric]) }
        return { ...next, impact: snapshotImpact(next, snapshot) ?? undefined }
      }),
    })
  }

  return (
    <section className="flex flex-col gap-1 rounded-2xl border border-brand/25 bg-brand/5 p-2">
      <h3 className="px-2 pt-1 text-xs font-medium text-brand-ink">In your plan</h3>
      <ul className="flex flex-col">
        {item.byKeepList ? (
          <li className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1">Dropped by the job's keep-list</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatDelta(-item.seriesCount)}
            </span>
            <Button size="xs" variant="outline" onClick={keepInList}>
              Keep it
            </Button>
          </li>
        ) : null}
        {item.rules.map((rule) => (
          <li key={rule.id} className="flex flex-col gap-1.5 rounded-xl px-2 py-1.5">
            <div className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 break-words">{ruleText(rule)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{savedText(rule)}</span>
              <Button size="xs" variant="ghost" onClick={() => removeRule(rule.id)}>
                Undo
              </Button>
            </div>
            <RuleMergeControl rule={rule} suggested={defaults.get(rule.id)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function useLabels(item: MetricWork, job: string) {
  const { data, isPending, error } = useMetricDrilldown(item.metric, job)
  const labels = React.useMemo(() => (data?.labels ?? []).filter((label) => label.label !== "job"), [data])
  return { labels, seriesCount: data?.seriesCount ?? item.seriesCount, isPending, error }
}

function LabelList({ job, item, onLabel }: { job: string; item: MetricWork; onLabel: (label: string) => void }) {
  const { labels, seriesCount, isPending, error } = useLabels(item, job)
  // A label with one value tells no series apart: removing it saves nothing.
  const varying = labels.filter((label) => label.cardinality > 1)
  const fixed = labels.length - varying.length
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
        Labels
        <InfoTip label="About labels">
          Each distinct combination of label values is a series. A label adds the series that would fold together without it;
          open a label to remove it, group its values or drop some of its series.
        </InfoTip>
        <span className="ml-auto font-normal">values · series it adds</span>
      </h3>
      {error ? (
        <p className="px-2 text-xs text-destructive">{error.message}</p>
      ) : isPending ? (
        <ListSkeleton />
      ) : varying.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">Every label has a single value: there is nothing to fold.</p>
      ) : (
        <ul className="flex flex-col">
          {varying.map((label, index) => (
            <LabelRow
              key={label.label}
              job={job}
              metric={item.metric}
              label={label.label}
              cardinality={label.cardinality}
              seriesCount={seriesCount}
              // The largest labels are measured and ID-checked up front, the rest on hover.
              eager={index < 4}
              onOpen={() => onLabel(label.label)}
            />
          ))}
        </ul>
      )}
      {fixed && !isPending ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {fixed} more label{fixed === 1 ? " has" : "s have"} a single value and add{fixed === 1 ? "s" : ""} no series.
        </p>
      ) : null}
    </section>
  )
}

/** Series a label adds: those that would fold together without it. */
function AddsCell({ metric, label, job, requested }: { metric: string; label: string; job: string; requested: boolean }) {
  const { data, isFetching, error } = useLabelDropImpact(metric, label, requested, job)
  if (!requested) return <span className="text-[11px] text-muted-foreground/60">hover</span>
  if (error) return <span className="text-[11px] text-muted-foreground" title={error.message}>n/a</span>
  if (!data) return isFetching ? <Spinner className="ml-auto size-3.5" /> : null
  const adds = data.seriesBefore - data.seriesAfter
  return (
    <span
      className={cn("text-xs tabular-nums", adds > 0 ? "font-medium" : "text-muted-foreground")}
      title={`Without ${label}, ${formatNumber(data.seriesBefore)} series fold into ${formatNumber(data.seriesAfter)}.`}
    >
      {adds > 0 ? `+${formatNumber(adds)}` : "0"}
    </span>
  )
}

function LabelRow({
  job,
  metric,
  label,
  cardinality,
  seriesCount,
  eager,
  onOpen,
}: {
  job: string
  metric: string
  label: string
  cardinality: number
  seriesCount: number
  eager: boolean
  onOpen: () => void
}) {
  const [hovered, setHovered] = React.useState(false)
  const values = useTopValues(metric, label, eager && cardinality >= 20, job)
  const verdict = React.useMemo(() => (values.data ? detectIdLike(values.data.map((item) => item.value)) : null), [values.data])
  const unique = cardinality === seriesCount
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHovered(true)}
        onFocus={() => setHovered(true)}
        className="group/option flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-mono text-xs" title={label}>
            {label}
          </span>
          {unique ? (
            <Badge variant="destructive" className="shrink-0">
              unique per series
            </Badge>
          ) : verdict ? (
            <IdBadge verdict={verdict} />
          ) : null}
          <DashboardLabelBadge metric={metric} label={label} />
        </span>
        <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{formatNumber(cardinality)}</span>
        <span className="w-16 shrink-0 text-right">
          <AddsCell metric={metric} label={label} job={job} requested={eager || hovered} />
        </span>
        <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/option:translate-x-0.5" />
      </button>
    </li>
  )
}

type LabelTool = "group" | "drop"

/** One label of the metric: what it adds, and the three things to do with it. */
function LabelPanel({ job, item, label }: { job: string; item: MetricWork; label: string }) {
  const { labels, seriesCount } = useLabels(item, job)
  const info = labels.find((entry) => entry.label === label)
  const { data: impact } = useLabelDropImpact(item.metric, label, true, job)
  const [tool, setTool] = React.useState<LabelTool | null>(null)
  const adds = impact ? impact.seriesBefore - impact.seriesAfter : null
  const bucket = label === "le" && histogramFamily(item.metric).part === "bucket"

  return (
    <section className="flex flex-col gap-3 px-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-sm">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {info ? `${formatNumber(info.cardinality)} values` : "…"}
          {adds === null ? "" : adds > 0 ? ` · adds ${formatNumber(adds)} of ${formatNumber(impact!.seriesBefore)} series` : " · adds no series"}
        </span>
      </div>
      {bucket ? (
        <p className="text-xs text-muted-foreground">le holds the histogram buckets: trim the buckets instead of removing it.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <DropToggle metric={item.metric} label={label} job={job} scope="job" idleText={`Remove ${label}`} size="lg" />
          <Button variant={tool === "group" ? "secondary" : "outline"} aria-pressed={tool === "group"} onClick={() => setTool("group")}>
            <SquaresFourIcon data-icon="inline-start" />
            Group values
          </Button>
          <Button variant={tool === "drop" ? "secondary" : "outline"} aria-pressed={tool === "drop"} onClick={() => setTool("drop")}>
            <FunnelIcon data-icon="inline-start" />
            Drop some series
          </Button>
        </div>
      )}
      {tool && !bucket ? (
        <LabelValues key={tool} metric={item.metric} label={label} job={job} scope="job" seriesCount={seriesCount} initialMode={tool} fixedMode />
      ) : (
        <p className="text-xs text-muted-foreground">
          {bucket
            ? ""
            : "Remove drops the label (Cardinal asks how to handle series that fold together). Group values folds many values into a few, like chrome-1 and chrome-2 into chrome. Drop some series removes only the series whose value matches a pattern."}
        </p>
      )}
    </section>
  )
}

function ListSkeleton() {
  return (
    <div className={cn("flex flex-col gap-2 px-2")}>
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-7" />
      ))}
    </div>
  )
}
