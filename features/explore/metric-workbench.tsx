import * as React from "react"
import { ArrowLeftIcon, CaretRightIcon, ChartBarIcon, FunnelIcon, ProhibitIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { jobPath, paths } from "@/app/paths"
import { useCost } from "@/components/cost-text"
import { DropToggle } from "@/components/drop-toggle"
import { InfoTip } from "@/components/info-tip"
import { RuleActions } from "@/components/rule-parts"
import { ShareBar } from "@/components/share-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { UnseenLabelsBanner } from "@/features/explore/aggregate-labels"
import { targetJob, type DropScope } from "@/features/explore/drop-scope"
import { IdBadge, LabelValues, useTopValues } from "@/features/explore/label-tools"
import { DashboardEvidenceLinks, EvidenceList } from "@/features/rules/drop-gate"
import { RuleMergeControl, useLabelDropImpact, useMergeDefaults } from "@/features/rules/merge-choice"
import { BucketPicker } from "@/features/rules/series-rule-forms"
import { useUsageEvidence } from "@/features/rules/usage"
import { DashboardLabelBadge } from "@/features/usage/dashboard-label-badge"
import { useConnection, useMetricDrilldown, useSeriesByJob } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { histogramFamily } from "@/lib/core/families"
import { detectIdLike } from "@/lib/core/id-like"
import type { MetricWork } from "@/lib/core/job-work"
import { jobLabel } from "@/lib/core/jobs"
import { snapshotImpact } from "@/lib/core/savings"
import { sortUnique, type KeepMetricsRule, type MetricRule } from "@/lib/core/rules"
import { summarizeEvidence } from "@/lib/core/usage-gate"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// One metric and what can be done with it, the same wherever it opens: a
// job's metric dialog, the Metrics list's dialog and the metric's own page.
// Four facts up top (series, what the plan saves, jobs, usage), then a short
// list of options; each opens its own tool (a label, buckets, jobs, usage),
// so only what the user picked is on screen.

export type MetricPanel = { view: "home" } | { view: "label"; label: string } | { view: "buckets" } | { view: "jobs" } | { view: "usage" }

export const HOME: MetricPanel = { view: "home" }

export function MetricWorkbench({
  item,
  job,
  scope = "job",
  used,
  panel,
  onPanel,
  onJob,
  onNavigate,
}: {
  item: MetricWork
  /** The job whose view this is; undefined is every job. */
  job?: string
  /** In a job's view, where new rules apply: that job, or every job. */
  scope?: DropScope
  used: boolean | undefined
  panel: MetricPanel
  onPanel: (panel: MetricPanel) => void
  /** Narrows the view to one job (or back to every job); without it the jobs list only links to each job. */
  onJob?: (job: string | undefined) => void
  /** Called when a link leaves this view (a dialog closes then). */
  onNavigate?: () => void
}) {
  const live = Boolean(useConnection())
  const ruleScope: DropScope = job === undefined ? "all" : scope
  return (
    <div className="flex flex-col gap-4">
      <Facts item={item} job={job} used={used} active={panel.view} onPanel={onPanel} />
      {panel.view === "home" ? (
        <Home job={job} scope={ruleScope} item={item} live={live} onPanel={onPanel} />
      ) : (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="self-start" onClick={() => onPanel(HOME)}>
            <ArrowLeftIcon data-icon="inline-start" />
            All options
          </Button>
          {panel.view === "label" ? <LabelPanel job={job} scope={ruleScope} item={item} label={panel.label} /> : null}
          {panel.view === "buckets" ? <BucketPicker metric={item.metric} job={targetJob(job, ruleScope)} /> : null}
          {panel.view === "jobs" ? <JobsPanel metric={item.metric} job={job} onJob={onJob} onNavigate={onNavigate} /> : null}
          {panel.view === "usage" ? <UsagePanel metric={item.metric} onNavigate={onNavigate} /> : null}
        </div>
      )}
    </div>
  )
}

function percent(part: number, total: number) {
  if (total <= 0) return "0%"
  const value = (part / total) * 100
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

function Facts({
  item,
  job,
  used,
  active,
  onPanel,
}: {
  item: MetricWork
  job?: string
  used: boolean | undefined
  active: MetricPanel["view"]
  onPanel: (panel: MetricPanel) => void
}) {
  const { format: formatCost } = useCost()
  const total = useAppStore((state) =>
    job === undefined ? (state.snapshot?.totalSeries ?? 0) : (state.snapshot?.jobs.find((entry) => entry.job === job)?.seriesCount ?? 0)
  )
  const byJob = useSeriesByJob(item.metric)
  const names = React.useMemo(() => [item.metric], [item.metric])
  const usage = useUsageEvidence(names)
  const evidence = usage.byMetric[item.metric]
  const summary = React.useMemo(() => (evidence ? summarizeEvidence(evidence) : null), [evidence])

  const cost = formatCost(item.seriesCount)
  const jobs = byJob.data ?? []
  const others = job === undefined ? jobs : jobs.filter((row) => row.job !== job)
  const otherSeries = others.reduce((sum, row) => sum + row.seriesCount, 0)
  const toggle = (view: "jobs" | "usage") => onPanel(active === view ? HOME : { view })

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Fact
        label="Series"
        value={formatNumber(item.seriesCount)}
        hint={`${percent(item.seriesCount, total)} of ${job === undefined ? "all series" : "the job"}${cost ? ` · ${cost}` : ""}`}
      />
      <Fact
        label="Your plan"
        tone={item.savedSeries > 0 ? "brand" : undefined}
        value={
          item.state === "dropped"
            ? "Dropped"
            : item.savedSeries > 0
              ? formatDelta(-item.savedSeries)
              : item.rules.length
                ? item.unmeasured
                  ? "Measuring…"
                  : "No change"
                : "Nothing yet"
        }
        hint={
          item.byKeepList
            ? "by the job's keep-list"
            : item.rules.length
              ? `${item.rules.length} rule${item.rules.length === 1 ? "" : "s"}`
              : "pick an option below"
        }
      />
      <Fact
        label={job === undefined ? "Jobs" : "Other jobs"}
        value={byJob.isPending ? "…" : formatNumber(others.length)}
        hint={
          byJob.isPending
            ? "counting"
            : job === undefined
              ? jobs[0]
                ? `most in ${jobLabel(jobs[0].job)}`
                : "none"
              : others.length
                ? `${formatNumber(otherSeries)} more series`
                : "only in this job"
        }
        active={active === "jobs"}
        onClick={() => toggle("jobs")}
      />
      <Fact
        label="Used by"
        tone={used === true ? "brand" : undefined}
        value={usage.isPending && !summary ? "…" : used === true ? "Used" : used === false ? "Nothing" : "Unsure"}
        hint={
          usage.isPending && !summary
            ? "checking"
            : summary?.used
              ? (summary.badge ?? "dashboards or rules")
              : used === false
                ? "no dashboard or rule"
                : "not fully checked"
        }
        active={active === "usage"}
        onClick={() => toggle("usage")}
      />
    </div>
  )
}

function Fact({
  label,
  value,
  hint,
  tone,
  active = false,
  onClick,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "brand"
  active?: boolean
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
        {label}
        {onClick ? (
          <CaretRightIcon className={cn("size-3 transition-transform group-hover/fact:translate-x-0.5", active && "rotate-90 group-hover/fact:translate-x-0")} />
        ) : null}
      </span>
      <span className={cn("truncate text-lg leading-tight font-medium tracking-tight tabular-nums", tone === "brand" && "text-brand-ink")}>{value}</span>
      {hint ? <span className="truncate text-[11px] text-muted-foreground">{hint}</span> : null}
    </>
  )
  const className = cn(
    "flex min-w-0 flex-col gap-0.5 rounded-2xl border border-well-border bg-well px-3 py-2 text-left [corner-shape:squircle]",
    onClick && "group/fact outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
    active && "border-brand/40 bg-brand/5 hover:bg-brand/10"
  )
  return onClick ? (
    <button type="button" aria-expanded={active} onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

function Home({
  job,
  scope,
  item,
  live,
  onPanel,
}: {
  job?: string
  scope: DropScope
  item: MetricWork
  live: boolean
  onPanel: (panel: MetricPanel) => void
}) {
  const gone = item.state === "dropped"
  const bucket = histogramFamily(item.metric).part === "bucket"
  const everywhere = targetJob(job, scope) === undefined
  return (
    <div className="flex flex-col gap-4">
      {item.rules.length || item.byKeepList ? <InPlan job={job} item={item} /> : null}
      <Suggested metric={item.metric} job={job} />
      {gone ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="px-2 text-xs font-medium text-muted-foreground">What you can do</h3>
          <ul className="flex flex-col">
            <li className="flex items-center gap-3 rounded-xl px-2 py-2">
              <OptionText
                icon={ProhibitIcon}
                title="Drop the whole metric"
                description={
                  everywhere
                    ? `Removes all ${formatNumber(item.seriesCount)} of its series, in every job.`
                    : `Removes its ${formatNumber(item.seriesCount)} series from this job.`
                }
              />
              <DropToggle metric={item.metric} job={job} scope={scope} />
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
        <LabelList
          job={job}
          scope={scope}
          item={item}
          // le holds a histogram's buckets: trimming them is the tool for it.
          onLabel={(label) => onPanel(bucket && label === "le" ? { view: "buckets" } : { view: "label", label })}
        />
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

/** What a rule does to the metric, in a few words (the metric is implied); `job` is the view's. */
function ruleText(rule: MetricRule, job: string | undefined) {
  const where =
    rule.selector.job === undefined ? (job === undefined ? "" : " in every job") : job === undefined ? ` in job ${jobLabel(rule.selector.job)}` : ""
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

function InPlan({ job, item }: { job?: string; item: MetricWork }) {
  const removeRule = useAppStore((state) => state.removeRule)
  const keepList = useAppStore((state) =>
    job === undefined
      ? undefined
      : state.rules.find((rule): rule is KeepMetricsRule => rule.kind === "keep_metrics" && rule.status === "active" && rule.selector.job === job)
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
            <span className="text-xs text-muted-foreground tabular-nums">{formatDelta(-item.seriesCount)}</span>
            <Button size="xs" variant="outline" onClick={keepInList}>
              Keep it
            </Button>
          </li>
        ) : null}
        {item.rules.map((rule) => (
          <li key={rule.id} className="flex flex-col gap-1.5 rounded-xl px-2 py-1.5">
            <div className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 break-words">{ruleText(rule, job)}</span>
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

/** Proposed rules for the metric (the agent's, or recommendations): accept or reject them here. */
function Suggested({ metric, job }: { metric: string; job?: string }) {
  const rules = useAppStore((state) => state.rules)
  const proposed = React.useMemo(
    () =>
      rules.filter(
        (rule): rule is MetricRule =>
          rule.status === "proposed" &&
          rule.kind !== "keep_metrics" &&
          rule.selector.metric === metric &&
          (job === undefined || rule.selector.job === undefined || rule.selector.job === job)
      ),
    [rules, metric, job]
  )
  if (proposed.length === 0) return null
  return (
    <section className="flex flex-col gap-1 rounded-2xl border border-border p-2">
      <h3 className="px-2 pt-1 text-xs font-medium text-muted-foreground">Suggested</h3>
      <ul className="flex flex-col">
        {proposed.map((rule) => (
          <li key={rule.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="break-words">{ruleText(rule, job)}</span>
              {rule.rationale ? <span className="line-clamp-2 text-xs text-muted-foreground">{rule.rationale}</span> : null}
            </span>
            <RuleActions rule={rule} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function useLabels(item: MetricWork, job: string | undefined) {
  const { data, isPending, error } = useMetricDrilldown(item.metric, job)
  const all = data?.labels
  const labels = React.useMemo(() => (all ?? []).filter((label) => label.label !== "job"), [all])
  return { all: all ?? [], labels, seriesCount: data?.seriesCount ?? item.seriesCount, isPending, error }
}

function LabelList({ job, scope, item, onLabel }: { job?: string; scope: DropScope; item: MetricWork; onLabel: (label: string) => void }) {
  const { all, labels, seriesCount, isPending, error } = useLabels(item, job)
  // A label with one value tells no series apart: removing it saves nothing.
  const varying = labels.filter((label) => label.cardinality > 1)
  const fixed = labels.length - varying.length
  const largest = varying[0]?.cardinality ?? 1
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
        Labels
        <InfoTip label="About labels">
          Each distinct combination of label values is a series. Values counts a label's distinct values; adds counts the series that
          would fold together without it. Open a label to remove it, group its values or drop some of its series.
        </InfoTip>
        <span className="ml-auto flex items-center gap-3 font-normal">
          <span className="w-20 text-right">values</span>
          <span className="w-16 text-right">adds</span>
          <span className="w-3.5" />
        </span>
      </h3>
      {error ? (
        <p className="px-2 text-xs text-destructive">{error.message}</p>
      ) : isPending ? (
        <ListSkeleton />
      ) : varying.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">Every label has a single value: there is nothing to fold.</p>
      ) : (
        <>
          <UnseenLabelsBanner metric={item.metric} job={targetJob(job, scope)} labels={all} />
          <ul className="flex flex-col">
            {varying.map((label, index) => (
              <LabelRow
                key={label.label}
                job={job}
                metric={item.metric}
                label={label.label}
                cardinality={label.cardinality}
                share={(label.cardinality / largest) * 100}
                seriesCount={seriesCount}
                // The largest labels are measured and ID-checked up front, the rest on hover.
                eager={index < 4}
                onOpen={() => onLabel(label.label)}
              />
            ))}
          </ul>
        </>
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
function AddsCell({ metric, label, job, requested }: { metric: string; label: string; job?: string; requested: boolean }) {
  const { data, isFetching, error } = useLabelDropImpact(metric, label, requested, job)
  if (!requested) return <span className="text-[11px] text-muted-foreground/60">hover</span>
  if (error)
    return (
      <span className="text-[11px] text-muted-foreground" title={error.message}>
        n/a
      </span>
    )
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
  share,
  seriesCount,
  eager,
  onOpen,
}: {
  job?: string
  metric: string
  label: string
  cardinality: number
  /** Values as a share of the label with the most, for the bar. */
  share: number
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
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
          <Progress value={Math.max(2, Math.min(100, share))} className="h-1 max-w-64" aria-hidden />
        </span>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatNumber(cardinality)}</span>
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
function LabelPanel({ job, scope, item, label }: { job?: string; scope: DropScope; item: MetricWork; label: string }) {
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
          <DropToggle metric={item.metric} label={label} job={job} scope={scope} idleText={`Remove ${label}`} size="lg" />
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
        <LabelValues key={tool} metric={item.metric} label={label} job={job} scope={scope} seriesCount={seriesCount} initialMode={tool} fixedMode />
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

const JOB_ROWS = 15

function JobsPanel({
  metric,
  job,
  onJob,
  onNavigate,
}: {
  metric: string
  job?: string
  onJob?: (job: string | undefined) => void
  onNavigate?: () => void
}) {
  const { data, isPending, error } = useSeriesByJob(metric)
  const rows = data ?? []
  const total = rows.reduce((sum, row) => sum + row.seriesCount, 0)
  return (
    <section className="flex flex-col gap-2 px-2">
      <h3 className="text-xs font-medium text-muted-foreground">Series by job</h3>
      {error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : isPending ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No job reports this metric right now.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, JOB_ROWS).map((row) => {
            const current = row.job === job
            return (
              <li key={row.job} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-sm">
                  <Link to={jobPath(row.job)} onClick={onNavigate} className="truncate hover:underline">
                    {jobLabel(row.job)}
                  </Link>
                  {current ? <Badge variant="secondary">this view</Badge> : null}
                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{formatNumber(row.seriesCount)}</span>
                  {onJob ? (
                    <Button
                      size="icon-xs"
                      variant={current ? "secondary" : "ghost"}
                      aria-pressed={current}
                      aria-label={current ? "Show every job" : `Show only job ${jobLabel(row.job)}`}
                      onClick={() => onJob(current ? undefined : row.job)}
                    >
                      <FunnelIcon weight={current ? "fill" : "regular"} />
                    </Button>
                  ) : null}
                </div>
                <ShareBar percent={(row.seriesCount / Math.max(1, total)) * 100} />
              </li>
            )
          })}
        </ul>
      )}
      {rows.length > JOB_ROWS ? (
        <p className="text-[11px] text-muted-foreground">
          {formatNumber(rows.length - JOB_ROWS)} more job{rows.length - JOB_ROWS === 1 ? "" : "s"} with fewer series.
        </p>
      ) : null}
    </section>
  )
}

function UsagePanel({ metric, onNavigate }: { metric: string; onNavigate?: () => void }) {
  const names = React.useMemo(() => [metric], [metric])
  const { byMetric, isPending } = useUsageEvidence(names)
  const evidence = byMetric[metric]
  const summary = React.useMemo(() => (evidence ? summarizeEvidence(evidence) : null), [evidence])
  return (
    <section className="flex flex-col gap-2 px-2">
      <h3 className="text-xs font-medium text-muted-foreground">What reads it</h3>
      {evidence?.rules?.length ? (
        <ItemGroup className="gap-1">
          {evidence.rules.map((usage, index) => (
            <Item key={`${usage.group}/${usage.name}/${index}`} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle className="font-mono text-xs">{usage.name}</ItemTitle>
                <ItemDescription>
                  {usage.type} · {usage.group}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      ) : null}
      {isPending ? null : <DashboardEvidenceLinks evidence={evidence} />}
      <EvidenceList summary={summary} pending={isPending} />
      {!isPending && !evidence?.dashboards ? (
        <Link to={`${paths.settings}#grafana`} onClick={onNavigate} className="self-start text-xs text-brand-ink hover:underline">
          Scan your Grafana dashboards
        </Link>
      ) : null}
    </section>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-7" />
      ))}
    </div>
  )
}
