import * as React from "react"
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChartBarIcon,
  CheckIcon,
  FunnelIcon,
  ProhibitIcon,
  SquaresFourIcon,
  TagIcon,
} from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { DropToggle } from "@/components/drop-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropImpactCell,
  IdBadge,
  LabelValues,
  useTopValues,
} from "@/features/explore/label-tools"
import { BucketPicker } from "@/features/rules/series-rule-forms"
import { RuleMergeControl, useMergeDefaults } from "@/features/rules/merge-choice"
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

type Panel =
  | { view: "home" }
  | { view: "labels" }
  | { view: "values"; mode: "group" | "drop"; label?: string }
  | { view: "buckets" }

/** Text fields and controls that use letters themselves. */
function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

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
  // Keep the last metric on screen while the dialog animates out.
  const [shown, setShown] = React.useState(index)
  if (index !== null && index !== shown) setShown(index)
  const position = index ?? shown ?? 0
  const metric = queue[position]
  const item = metric === undefined ? undefined : work.get(metric)
  const setKeptAsIs = useAppStore((state) => state.setKeptAsIs)

  const go = (step: number) => {
    const next = position + step
    if (next >= 0 && next < queue.length) onIndex(next)
  }
  // After "Keep as is": the next metric nobody looked at yet, else close.
  const nextOpen = () => {
    const next = queue.findIndex(
      (name, at) => at > position && work.get(name)?.state === "open"
    )
    if (next === -1) onClose()
    else onIndex(next)
  }

  return (
    <Dialog
      open={index !== null && item !== undefined}
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <DialogContent
        // Pinned near the top: stepping through metrics and opening tools changes its height, so it grows down instead of jumping.
        className="top-4 grid max-h-[calc(100svh-2rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:top-[10svh] sm:max-h-[80svh] sm:max-w-2xl"
        // Focus the dialog, not its first control (whose tooltip would pop up); J and K work from there.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        onKeyDown={(event) => {
          if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === "j") {
            event.preventDefault()
            go(1)
          } else if (event.key === "k") {
            event.preventDefault()
            go(-1)
          }
        }}
      >
        {item ? (
          <MetricWorkBody key={item.metric} job={job} item={item} used={used[item.metric]} />
        ) : null}
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-2 border-t border-border/60 p-3">
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous metric"
              disabled={position === 0}
              onClick={() => go(-1)}
            >
              <CaretLeftIcon />
            </Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
              {position + 1} of {queue.length}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next metric"
              disabled={position >= queue.length - 1}
              onClick={() => go(1)}
            >
              <CaretRightIcon />
            </Button>
            <span className="ml-1 hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
          {item?.state === "open" ? (
            <Button
              variant="outline"
              onClick={() => {
                setKeptAsIs(job, item.metric, true)
                nextOpen()
              }}
            >
              <CheckIcon data-icon="inline-start" />
              Keep as is
            </Button>
          ) : item?.state === "kept" ? (
            <Button variant="ghost" onClick={() => setKeptAsIs(job, item.metric, false)}>
              Kept as is · Undo
            </Button>
          ) : position < queue.length - 1 ? (
            <Button onClick={() => go(1)}>
              Next metric
              <CaretRightIcon data-icon="inline-end" />
            </Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            {panel.view === "labels" ? <LabelsPanel job={job} item={item} /> : null}
            {panel.view === "buckets" ? <BucketPicker metric={item.metric} job={job} /> : null}
            {panel.view === "values" ? (
              <ValuesPanel
                job={job}
                item={item}
                mode={panel.mode}
                label={panel.label}
                onLabel={(label) => setPanel({ ...panel, label })}
              />
            ) : null}
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
            <OptionButton
              icon={TagIcon}
              title="Remove labels"
              description="Each label removed can fold series into fewer."
              disabled={!live}
              onClick={() => onPanel({ view: "labels" })}
            />
            <OptionButton
              icon={SquaresFourIcon}
              title="Group label values"
              description="Fold many values into a few, like chrome-1 and chrome-2 into chrome."
              disabled={!live}
              onClick={() => onPanel({ view: "values", mode: "group" })}
            />
            <OptionButton
              icon={FunnelIcon}
              title="Drop some series"
              description="Only the series whose label matches a pattern."
              disabled={!live}
              onClick={() => onPanel({ view: "values", mode: "drop" })}
            />
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
          {live ? null : (
            <p className="px-2 text-xs text-muted-foreground">
              Label tools need a live connection; a pasted snapshot only counts series.
            </p>
          )}
        </section>
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

function LabelsPanel({ job, item }: { job: string; item: MetricWork }) {
  const { labels, seriesCount, isPending, error } = useLabels(item, job)
  if (error) return <p className="px-2 text-xs text-destructive">{error.message}</p>
  if (isPending) return <ListSkeleton />
  // A label with one value tells no series apart: removing it saves nothing.
  const varying = labels.filter((label) => label.cardinality > 1)
  const fixed = labels.length - varying.length
  return (
    <section className="flex flex-col gap-1">
      <p className="px-2 text-xs text-muted-foreground">
        Removing a label saves series only when series that differ by it fold together. Cardinal measures each label and asks
        how to handle a merge.
      </p>
      <ul className="flex flex-col">
        {varying.map((label, index) => (
          <LabelChoice
            key={label.label}
            job={job}
            metric={item.metric}
            label={label.label}
            cardinality={label.cardinality}
            seriesCount={seriesCount}
            // The largest labels are measured and ID-checked up front, the rest on hover.
            eager={index < 5}
          />
        ))}
      </ul>
      {fixed ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {fixed} label{fixed === 1 ? " has" : "s have"} a single value; removing {fixed === 1 ? "it" : "them"} saves no series.
        </p>
      ) : null}
    </section>
  )
}

function LabelChoice({
  job,
  metric,
  label,
  cardinality,
  seriesCount,
  eager,
}: {
  job: string
  metric: string
  label: string
  cardinality: number
  seriesCount: number
  eager: boolean
}) {
  const [hovered, setHovered] = React.useState(false)
  const values = useTopValues(metric, label, eager && cardinality >= 20, job)
  const verdict = React.useMemo(() => (values.data ? detectIdLike(values.data.map((item) => item.value)) : null), [values.data])
  const unique = cardinality > 1 && cardinality === seriesCount
  return (
    <li
      className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-accent/60"
      onMouseEnter={() => setHovered(true)}
      onFocus={() => setHovered(true)}
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
      <span className="hidden w-20 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums sm:inline">
        {formatNumber(cardinality)} values
      </span>
      <span className="w-20 shrink-0 text-right">
        <DropImpactCell metric={metric} label={label} job={job} requested={eager || hovered} />
      </span>
      <DropToggle metric={metric} label={label} job={job} scope="job" idleText="Remove" />
    </li>
  )
}

function ValuesPanel({
  job,
  item,
  mode,
  label,
  onLabel,
}: {
  job: string
  item: MetricWork
  mode: "group" | "drop"
  label?: string
  onLabel: (label: string | undefined) => void
}) {
  const { labels, seriesCount, isPending, error } = useLabels(item, job)
  if (label) {
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <span>
            Label <span className="font-mono text-foreground">{label}</span>
          </span>
          <button type="button" className="text-brand-ink hover:underline" onClick={() => onLabel(undefined)}>
            Change
          </button>
        </div>
        <div className="px-2">
          <LabelValues key={label} metric={item.metric} label={label} job={job} scope="job" seriesCount={seriesCount} initialMode={mode} />
        </div>
      </section>
    )
  }
  if (error) return <p className="px-2 text-xs text-destructive">{error.message}</p>
  if (isPending) return <ListSkeleton />
  const choices = labels.filter((item) => item.label !== "le" && item.cardinality > 1)
  return (
    <section className="flex flex-col gap-1">
      <p className="px-2 text-xs text-muted-foreground">
        {mode === "group" ? "Which label's values do you want to group?" : "Which label do you want to match series on?"}
      </p>
      {choices.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">No label has more than one value.</p>
      ) : (
        <ul className="flex flex-col">
          {choices.map((choice) => (
            <li key={choice.label}>
              <button
                type="button"
                onClick={() => onLabel(choice.label)}
                className="group/option flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{choice.label}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{formatNumber(choice.cardinality)} values</span>
                <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/option:translate-x-0.5" />
              </button>
            </li>
          ))}
        </ul>
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
