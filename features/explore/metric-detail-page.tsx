import * as React from "react"
import { ChartBarIcon, FunnelIcon, SlidersHorizontalIcon, TagIcon, XIcon } from "@phosphor-icons/react"
import { Link, useParams, useSearchParams } from "react-router"

import { jobPath } from "@/app/paths"
import { CopyButton } from "@/components/code-block"
import { useCost } from "@/components/cost-text"
import { DropToggle } from "@/components/drop-toggle"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { InfoTip } from "@/components/info-tip"
import { DropScopeToggle, RuleActions, RuleDescription, RuleImpact, RuleOriginBadge } from "@/components/rule-parts"
import { ShareBar } from "@/components/share-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { targetJob, type DropScope } from "@/features/explore/drop-scope"
import { DropImpactCell, IdBadge, LabelValues, useTopValues } from "@/features/explore/label-tools"
import { HistogramPanel } from "@/features/histograms/histogram-panel"
import { DashboardEvidenceLinks, EvidenceList } from "@/features/rules/drop-gate"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { UnseenLabelsBanner } from "@/features/explore/aggregate-labels"
import { RuleMergeControl, useMergeDefaults } from "@/features/rules/merge-choice"
import { useUsageEvidence } from "@/features/rules/usage"
import { DashboardLabelBadge } from "@/features/usage/dashboard-label-badge"
import { useConnection, useMetricDrilldown, useSeriesByJob } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { histogramFamily } from "@/lib/core/families"
import { detectIdLike } from "@/lib/core/id-like"
import { jobFromParam, jobLabel, jobToParam } from "@/lib/core/jobs"
import { shadowedBy } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import { summarizeEvidence } from "@/lib/core/usage-gate"
import { metricDropRule, selectionView, useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

function LabelRow({
  metric,
  label,
  cardinality,
  index,
  maxCardinality,
  seriesCount,
  job,
  scope,
  open,
  autoCheck,
  selected,
  metricDropped,
  onToggle,
}: {
  metric: string
  label: string
  cardinality: number
  index: number
  maxCardinality: number
  seriesCount: number
  job?: string
  scope: DropScope
  open: boolean
  /** Fetch top values up front (for the ID check) without waiting for a hover. */
  autoCheck: boolean
  selected: boolean
  metricDropped: boolean
  onToggle: () => void
}) {
  const [hovered, setHovered] = React.useState(false)
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const requested = open || hovered
  const values = useTopValues(metric, label, requested || autoCheck, job)
  const verdict = React.useMemo(() => (values.data ? detectIdLike(values.data.map((item) => item.value)) : null), [values.data])
  const unique = cardinality > 1 && cardinality === seriesCount
  React.useEffect(() => () => clearTimeout(hoverTimer.current), [])

  return (
    <>
      <TableRow
        className="animate-blur-in cursor-pointer data-[state=selected]:bg-destructive/[0.04]"
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        data-state={selected ? "selected" : undefined}
        onMouseEnter={() => {
          hoverTimer.current = setTimeout(() => setHovered(true), 180)
        }}
        onMouseLeave={() => clearTimeout(hoverTimer.current)}
        onFocus={() => setHovered(true)}
        onClick={(event) => {
          if (!(event.target instanceof Element && event.target.closest("button"))) onToggle()
        }}
      >
        <TableCell>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Values of ${label} and what to do with them`}
            onClick={onToggle}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <SlidersHorizontalIcon />
          </button>
        </TableCell>
        <TableCell className="max-w-0 min-w-28 font-mono text-xs sm:min-w-40">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate" title={label}>
              {label}
            </span>
            {unique ? (
              <Badge variant="destructive" className="shrink-0">
                unique per series
              </Badge>
            ) : null}
            {verdict ? <IdBadge verdict={verdict} /> : null}
            <DashboardLabelBadge metric={metric} label={label} />
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatNumber(cardinality)}</TableCell>
        <TableCell className="hidden text-right sm:table-cell">
          <DropImpactCell metric={metric} label={label} job={job} requested={requested} />
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <ShareBar percent={(cardinality / Math.max(1, maxCardinality)) * 100} showValue={false} />
        </TableCell>
        <TableCell className="text-right">
          <DropToggle metric={metric} label={label} job={job} scope={scope} size="responsive" reveal disabled={metricDropped} />
        </TableCell>
      </TableRow>
    </>
  )
}

function LabelsCard({
  metric,
  job,
  scope,
  expanded,
  onExpand,
  className,
}: {
  metric: string
  job?: string
  scope: DropScope
  expanded: string | null
  onExpand: (label: string | null) => void
  className?: string
}) {
  const { data, isPending, error } = useMetricDrilldown(metric, job)
  const live = Boolean(useConnection())
  const rules = useAppStore((state) => state.rules)
  const { selectedLabelsByMetric, dropMetrics } = React.useMemo(() => selectionView(rules, job), [rules, job])
  const selected = new Set(selectedLabelsByMetric[metric] ?? [])
  const metricDropped = dropMetrics.includes(metric)

  return (
    <Card id="labels" className={cn("scroll-mt-36 transition-shadow duration-500", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          Labels
          <InfoTip label="About this table">
            Distinct values per label (its cardinality), largest first. Hover a label to measure how many series dropping it removes;
            open it to see its top values, then drop the series matching a pattern or group the values.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load labels</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : !live ? (
          <p className="py-2 text-sm text-muted-foreground">Label breakdowns need a live connection; a pasted snapshot only counts series per job.</p>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-8" />
            ))}
          </div>
        ) : (
          <>
            <UnseenLabelsBanner metric={metric} job={targetJob(job, scope)} labels={data.labels} />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Label</TableHead>
                  <TableHead className="text-right">Values</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-[3px]">
                          −series if dropped
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64">Measured on hover with count(count without (label) (…)).</TooltipContent>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="hidden w-36 md:table-cell">Relative</TableHead>
                  <TableHead className="w-12 text-right sm:w-28">
                    <span className="sr-only sm:not-sr-only">Rule</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.labels.map((label, index, labels) => (
                  <LabelRow
                    key={label.label}
                    metric={metric}
                    label={label.label}
                    cardinality={label.cardinality}
                    index={index}
                    maxCardinality={labels[0]?.cardinality ?? 1}
                    seriesCount={data.seriesCount}
                    job={job}
                    scope={scope}
                    open={expanded === label.label}
                    // The largest labels are the likely ID suspects: check them without a hover.
                    autoCheck={index < 4 && label.cardinality >= 20}
                    selected={selected.has(label.label)}
                    metricDropped={metricDropped}
                    onToggle={() => onExpand(expanded === label.label ? null : label.label)}
                  />
                ))}
              </TableBody>
            </Table>
            <LabelDialog
              metric={metric}
              job={job}
              scope={scope}
              label={expanded}
              info={data.labels.find((item) => item.label === expanded)}
              seriesCount={data.seriesCount}
              onClose={() => onExpand(null)}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * A label's top values and what to do with them (drop matching series,
 * group values, trim buckets), in a dialog so the table stays put. Keeps
 * showing the last label while the dialog animates out.
 */
function LabelDialog({
  metric,
  job,
  scope,
  label,
  info,
  seriesCount,
  onClose,
}: {
  metric: string
  job?: string
  scope: DropScope
  label: string | null
  info?: { label: string; cardinality: number }
  seriesCount: number
  onClose: () => void
}) {
  const [shown, setShown] = React.useState(label)
  if (label !== null && label !== shown) setShown(label)
  const open = label !== null && Boolean(info)
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="font-mono">{shown}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {info ? `${formatNumber(info.cardinality)} values on ` : ""}
            <span className="font-mono">{metric}</span>
            {job !== undefined ? ` · job ${jobLabel(job)}` : ""}. Fewer values means fewer active series.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-5 pb-5">
          {shown ? <LabelValues key={shown} metric={metric} label={shown} job={job} scope={scope} seriesCount={seriesCount} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SeriesByJobCard({ metric, job, onFilter }: { metric: string; job?: string; onFilter: (job: string | undefined) => void }) {
  const { data, isPending } = useSeriesByJob(metric)
  const total = data?.reduce((sum, row) => sum + row.seriesCount, 0) ?? 0
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Series by job</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isPending ? (
          <Skeleton className="h-16" />
        ) : (
          data?.slice(0, 10).map((row) => {
            const active = job === row.job
            return (
              <div key={row.job} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <Link to={jobPath(row.job)} className="truncate hover:underline">
                    {jobLabel(row.job)}
                  </Link>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="tabular-nums text-muted-foreground">{formatNumber(row.seriesCount)}</span>
                    <Button
                      size="icon-xs"
                      variant={active ? "secondary" : "ghost"}
                      aria-pressed={active}
                      aria-label={active ? `Show all jobs` : `Show only job ${jobLabel(row.job)}`}
                      onClick={() => onFilter(active ? undefined : row.job)}
                    >
                      <FunnelIcon weight={active ? "fill" : "regular"} />
                    </Button>
                  </span>
                </div>
                <ShareBar percent={(row.seriesCount / Math.max(1, total)) * 100} />
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

function UsageCard({ metric }: { metric: string }) {
  const { byMetric, isPending } = useUsageEvidence([metric])
  const evidence = byMetric[metric]
  const summary = React.useMemo(() => (evidence ? summarizeEvidence(evidence) : null), [evidence])
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Used by</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
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
        <EvidenceList summary={summary} pending={isPending} compact />
      </CardContent>
    </Card>
  )
}

function MetricRulesCard({ metric, totalSeries }: { metric: string; totalSeries: number }) {
  const allRules = useAppStore((state) => state.rules)
  const rules = React.useMemo(() => allRules.filter((rule) => rule.selector.metric === metric && rule.status !== "rejected"), [allRules, metric])
  const { defaults } = useMergeDefaults(rules)
  // Nothing to show until there's a rule: the header's actions make one.
  if (rules.length === 0) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Rules</CardTitle>
      </CardHeader>
      <CardContent>
        <ItemGroup className="gap-2">
          {rules.map((rule) => (
            <Item key={rule.id} variant="outline" size="sm" className="items-start">
              <ItemContent className="min-w-0 gap-2">
                <RuleDescription rule={rule} hideMetric supersededBy={rule.status === "active" ? shadowedBy(rule, allRules) : undefined} />
                <div className="flex flex-wrap items-center gap-1">
                  <RuleOriginBadge rule={rule} />
                  {rule.status === "proposed" ? <Badge variant="secondary">Proposed</Badge> : null}
                </div>
                {rule.rationale ? <ItemDescription className="line-clamp-3">{rule.rationale}</ItemDescription> : null}
                <RuleMergeControl rule={rule} suggested={defaults.get(rule.id)} />
              </ItemContent>
              <div className="flex flex-col items-end gap-2">
                <RuleImpact rule={rule} totalSeries={totalSeries} />
                <RuleActions rule={rule} />
              </div>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  )
}

const FLASH = "ring-2 ring-brand/60 ring-offset-2 ring-offset-background"

/** Scrolls to a section and rings it briefly, so a header action shows where it leads. */
function useFlash() {
  const [target, setTarget] = React.useState<string | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const flash = (id: string) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" })
    setTarget(id)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setTarget(null), 1600)
  }
  return { flashed: (id: string) => (target === id ? FLASH : undefined), flash }
}

function MetricDetail({ metric, snapshot }: { metric: string; snapshot: Snapshot }) {
  const summary = snapshot.metrics.find((item) => item.metric === metric)
  const rules = useAppStore((state) => state.rules)
  const [params, setParams] = useSearchParams()
  const jobParam = params.get("job")
  const job = jobParam === null ? undefined : jobFromParam(jobParam)
  const expanded = params.get("label")
  const [scope, setScope] = React.useState<DropScope>("job")
  const { format: formatCost } = useCost()
  const { flashed, flash } = useFlash()
  const isBucket = histogramFamily(metric).part === "bucket"

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true }
    )

  // Without a job this is the all-jobs view: its drops manage rules for every job.
  const dropped = Boolean(metricDropRule(rules, metric, job))
  const scopedDrops = rules.filter(
    (rule) => rule.status === "active" && rule.kind === "drop_metric" && rule.selector.metric === metric && rule.selector.job !== undefined
  ).length
  const link = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}${params.size ? `?${params}` : ""}`

  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <Badge variant="outline">Metric</Badge>
            {job !== undefined ? (
              <Badge variant="secondary" asChild>
                <button type="button" onClick={() => update({ job: null })} aria-label={`Clear the job filter (${jobLabel(job)})`}>
                  job {jobLabel(job)}
                  <XIcon data-icon="inline-end" />
                </button>
              </Badge>
            ) : summary?.topJob !== undefined ? (
              <Badge variant="ghost" asChild>
                <Link to={jobPath(summary.topJob)}>{jobLabel(summary.topJob)}</Link>
              </Badge>
            ) : null}
            {scopedDrops && !dropped ? (
              <Badge variant="outline">
                Dropped in {scopedDrops} job{scopedDrops === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </>
        }
        title={<span className="font-mono">{metric}</span>}
        description={
          summary ? (
            <span className="tabular-nums" title={`${summary.percentageOfTotal.toFixed(2)}% of all series`}>
              <span className="font-medium text-foreground">{formatNumber(summary.seriesCount)} series</span>
              {formatCost(summary.seriesCount) ? ` · ${formatCost(summary.seriesCount)}` : ""}
            </span>
          ) : (
            "Not in the current snapshot."
          )
        }
        actions={
          <>
            {job !== undefined ? <DropScopeToggle value={scope} onChange={setScope} job={job} /> : null}
            <DropToggle metric={metric} job={job} scope={scope} size="lg" idleText="Drop metric" />
            <Button variant="outline" onClick={() => flash("labels")}>
              <TagIcon data-icon="inline-start" />
              Drop labels…
            </Button>
            {isBucket ? (
              <Button variant="outline" onClick={() => flash("histogram")}>
                <ChartBarIcon data-icon="inline-start" />
                Trim buckets
              </Button>
            ) : null}
            <CopyButton text={link} label="Copy link" className="h-8 px-3" />
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <LabelsCard
          metric={metric}
          job={job}
          scope={job === undefined ? "all" : scope}
          expanded={expanded}
          onExpand={(label) => update({ label })}
          className={flashed("labels")}
        />
        <div className="flex flex-col gap-4">
          <MetricRulesCard metric={metric} totalSeries={snapshot.totalSeries} />
          <HistogramPanel metric={metric} className={flashed("histogram")} />
          <SeriesByJobCard metric={metric} job={job} onFilter={(next) => update({ job: next === undefined ? null : jobToParam(next) })} />
          <UsageCard metric={metric} />
        </div>
      </div>
    </Page>
  )
}

export function MetricDetailPage() {
  const { metric = "" } = useParams()
  return <RequireSnapshot>{(snapshot) => <MetricDetail key={metric} metric={metric} snapshot={snapshot} />}</RequireSnapshot>
}
