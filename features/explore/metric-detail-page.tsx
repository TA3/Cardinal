import * as React from "react"
import { CaretDownIcon, CaretRightIcon, FingerprintIcon, FunnelIcon, ShieldCheckIcon, WarningIcon, XIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { Link, useParams, useSearchParams } from "react-router"

import { jobPath } from "@/app/paths"
import { CopyButton } from "@/components/code-block"
import { DropToggle } from "@/components/drop-toggle"
import { EmptyState } from "@/components/empty-state"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { DropScopeToggle, MergeNote, RuleActions, RuleDescription, RuleImpact, RuleOriginBadge } from "@/components/rule-parts"
import { ShareBar } from "@/components/share-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { targetJob, type DropScope } from "@/features/explore/drop-scope"
import { HistogramPanel } from "@/features/histograms/histogram-panel"
import { DashboardEvidenceLinks, EvidenceList } from "@/features/rules/drop-gate"
import { BucketPicker, SeriesPatternForm, valuesPattern } from "@/features/rules/series-rule-forms"
import { Term } from "@/features/rules/term"
import { useUsageEvidence } from "@/features/rules/usage"
import { DashboardLabelBadge } from "@/features/usage/dashboard-label-badge"
import { connectionKey, useConnection, useLabelValues, useMetricDrilldown, useSeriesByJob } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { createLimiter } from "@/lib/core/concurrency"
import { histogramFamily } from "@/lib/core/families"
import { detectIdLike, generalizePath, ID_KIND_LABEL, type IdLikeVerdict } from "@/lib/core/id-like"
import { jobFromParam, jobLabel, jobToParam } from "@/lib/core/jobs"
import { fullMatch } from "@/lib/core/regex"
import { shadowedBy } from "@/lib/core/rules"
import type { Snapshot } from "@/lib/core/snapshot"
import { summarizeEvidence } from "@/lib/core/usage-gate"
import { fetchTopLabelValues, measureImpact } from "@/lib/sources/prometheus"
import { metricDropRule, selectionView, useAppStore } from "@/lib/store/app-store"

// Label measurements (−series if dropped, top values for the ID check) start
// on hover or expand; at most two run at once so sweeping over the table
// doesn't flood the backend.
const measure = createLimiter(2)
const TOP_VALUES = 25

/** Top values of a label, shared with the expanded list (same cache key as useLabelValues). */
function useTopValues(metric: string, label: string, enabled: boolean, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["label-values", connectionKey(connection), metric, label, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: ({ signal }) => measure(() => fetchTopLabelValues(connection!, metric, label, { job, limit: TOP_VALUES, signal })),
    staleTime: 5 * 60_000,
  })
}

/** Series removed if `label` were dropped: `count(sel) − count(count without (label) (sel))`. */
function useLabelDropImpact(metric: string, label: string, enabled: boolean, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["label-drop-impact", connectionKey(connection), metric, label, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: ({ signal }) =>
      measure(() =>
        measureImpact(connection!, { kind: "drop_labels", selector: job === undefined ? { metric } : { metric, job }, labels: [label] }, signal)
      ),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

function DropImpactCell({ metric, label, job, requested }: { metric: string; label: string; job?: string; requested: boolean }) {
  const { data, isFetching, error } = useLabelDropImpact(metric, label, requested, job)
  if (!requested) return <span className="text-xs text-muted-foreground/60">hover</span>
  if (error) return <span className="text-xs text-muted-foreground" title={error.message}>n/a</span>
  if (!data) return isFetching ? <Spinner className="ml-auto size-3.5" /> : null
  const saved = data.seriesBefore - data.seriesAfter
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex flex-col items-end tabular-nums" tabIndex={0}>
          <span className="text-sm">{formatDelta(-saved)}</span>
          {data.mergesSeries ? <span className="text-[11px] text-destructive">merges series</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {data.mergesSeries
          ? `Dropping ${label} collapses ${formatNumber(data.seriesBefore)} series into ${formatNumber(data.seriesAfter)}. That needs aggregation; a relabel drop would create duplicate samples.`
          : `Every series stays distinct without ${label}, so a relabel drop is safe but saves no series (only bytes).`}
      </TooltipContent>
    </Tooltip>
  )
}

function IdBadge({ verdict }: { verdict: IdLikeVerdict }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0 border-brand/40 text-brand-ink" tabIndex={0}>
          <FingerprintIcon data-icon="inline-start" />
          looks like IDs
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {Math.round(verdict.share * 100)}% of the top values look like {ID_KIND_LABEL[verdict.kind]} (e.g. {verdict.examples[0]}). Labels like this
        grow without bound; drop the label, or drop the series matching a pattern.
      </TooltipContent>
    </Tooltip>
  )
}

function LabelValues({
  metric,
  label,
  job,
  scope,
  seriesCount,
}: {
  metric: string
  label: string
  job?: string
  scope: DropScope
  seriesCount: number
}) {
  const { data, isPending, error } = useLabelValues(metric, label, true, job)
  const [pattern, setPattern] = React.useState("")
  const ruleJob = targetJob(job, scope)

  if (label === "le" && histogramFamily(metric).part === "bucket") return <BucketPicker metric={metric} job={ruleJob} />
  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Spinner />
        Loading top values…
      </div>
    )
  }
  if (error) return <p className="py-2 text-xs text-destructive">{error.message}</p>

  const verdict = detectIdLike(data.map((item) => item.value))
  const suggestion = verdict?.kind === "path" ? generalizePath(verdict.examples[0]) : null
  const matches = (regex: string, value: string) => Boolean(regex) && fullMatch(regex, value)
  const picked = (value: string) => matches(pattern, value)
  const pick = (value: string) =>
    // Clicking toggles the value in a literal alternation of the picked values.
    setPattern((previous) => {
      const current = data.filter((item) => matches(previous, item.value)).map((item) => item.value)
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      return next.length ? valuesPattern(next) : ""
    })

  return (
    <div className="py-2">
      <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        {data.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={picked(item.value)}
            title="Add to the series pattern"
            onClick={() => pick(item.value)}
            className="flex min-w-0 items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-destructive/10 aria-pressed:text-destructive"
          >
            <span className="truncate font-mono">{item.value || <em className="text-muted-foreground">empty</em>}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatNumber(item.seriesCount)} · {((item.seriesCount / Math.max(1, seriesCount)) * 100).toFixed(1)}%
            </span>
          </button>
        ))}
      </div>
      <SeriesPatternForm
        metric={metric}
        label={label}
        job={ruleJob}
        values={data}
        seriesCount={seriesCount}
        pattern={pattern}
        setPattern={setPattern}
        suggestion={suggestion}
      />
    </div>
  )
}

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
            aria-expanded={open}
            aria-controls={`values-${index}`}
            aria-label={`${open ? "Hide" : "Show"} top values of ${label}`}
            onClick={onToggle}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {open ? <CaretDownIcon /> : <CaretRightIcon />}
          </button>
        </TableCell>
        <TableCell className="max-w-0 min-w-40 font-mono text-xs">
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
        <TableCell className="text-right">
          <DropImpactCell metric={metric} label={label} job={job} requested={requested} />
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <ShareBar percent={(cardinality / Math.max(1, maxCardinality)) * 100} showValue={false} />
        </TableCell>
        <TableCell className="text-right">
          <DropToggle metric={metric} label={label} job={job} scope={scope} size="responsive" reveal disabled={metricDropped} />
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow id={`values-${index}`} className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={5} className="whitespace-normal">
            <LabelValues metric={metric} label={label} job={job} scope={scope} seriesCount={seriesCount} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function LabelsCard({
  metric,
  job,
  scope,
  expanded,
  onExpand,
}: {
  metric: string
  job?: string
  scope: DropScope
  expanded: string | null
  onExpand: (label: string | null) => void
}) {
  const { data, isPending, error } = useMetricDrilldown(metric, job)
  const rules = useAppStore((state) => state.rules)
  const { selectedLabelsByMetric, dropMetrics } = React.useMemo(() => selectionView(rules, job), [rules, job])
  const selected = new Set(selectedLabelsByMetric[metric] ?? [])
  const metricDropped = dropMetrics.includes(metric)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Labels</CardTitle>
        <CardDescription>
          Distinct values per label (its <Term id="cardinality">cardinality</Term>), largest first. Hover a label to measure how many{" "}
          <Term id="activeSeries">series</Term> dropping it removes; expand it to see its top values and drop only the series matching
          a pattern.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load labels</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-8" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Label</TableHead>
                <TableHead className="text-right">Values</TableHead>
                <TableHead className="text-right">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-[3px]">
                        −series if dropped
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      Measured on hover with count(count without (label) (…)). Labels that merge series need aggregation, not relabelling.
                    </TooltipContent>
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
        )}
      </CardContent>
    </Card>
  )
}

function SeriesByJobCard({ metric, job, onFilter }: { metric: string; job?: string; onFilter: (job: string | undefined) => void }) {
  const { data, isPending } = useSeriesByJob(metric)
  const total = data?.reduce((sum, row) => sum + row.seriesCount, 0) ?? 0
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Series by job</CardTitle>
        <CardDescription>Filter the labels to one job.</CardDescription>
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
        <CardDescription>Alerting and recording rules, Grafana dashboards and alerts once scanned in Settings, and Grafana Cloud usage.</CardDescription>
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
        <EvidenceList summary={summary} pending={isPending} />
      </CardContent>
    </Card>
  )
}

function MetricRulesCard({ metric, totalSeries }: { metric: string; totalSeries: number }) {
  const allRules = useAppStore((state) => state.rules)
  const rules = allRules.filter((rule) => rule.selector.metric === metric && rule.status !== "rejected")
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Rules</CardTitle>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <EmptyState compact icon={ShieldCheckIcon} title="No rules yet" description="Drop the metric or pick labels to drop." />
        ) : (
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
                  <MergeNote rule={rule} />
                </ItemContent>
                <div className="flex flex-col items-end gap-2">
                  <RuleImpact rule={rule} totalSeries={totalSeries} />
                  <RuleActions rule={rule} />
                </div>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

function MetricDetail({ metric, snapshot }: { metric: string; snapshot: Snapshot }) {
  const summary = snapshot.metrics.find((item) => item.metric === metric)
  const rules = useAppStore((state) => state.rules)
  const [params, setParams] = useSearchParams()
  const jobParam = params.get("job")
  const job = jobParam === null ? undefined : jobFromParam(jobParam)
  const expanded = params.get("label")
  const [scope, setScope] = React.useState<DropScope>("job")

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
  const hasMergingRule = rules.some((rule) => rule.selector.metric === metric && rule.status === "active" && rule.impact?.mergesSeries)
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
          summary
            ? `${formatNumber(summary.seriesCount)} active series, ${summary.percentageOfTotal.toFixed(2)}% of the total.${job !== undefined ? ` Labels below are for job ${jobLabel(job)}.` : ""}`
            : "Not in the current snapshot."
        }
        actions={
          <>
            {job !== undefined ? <DropScopeToggle value={scope} onChange={setScope} job={job} /> : null}
            <CopyButton text={link} label="Copy link" className="h-8 px-3" />
            <DropToggle metric={metric} job={job} scope={scope} size="lg" />
          </>
        }
      />
      {hasMergingRule ? (
        <Alert>
          <WarningIcon />
          <AlertTitle>
            Some label drops <Term id="mergesSeries">merge series</Term>
          </AlertTitle>
          <AlertDescription>
            Those only work as Adaptive Metrics aggregations; relabel exports skip them. Each rule below says how many series collapse
            and offers relabel-safe alternatives.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <LabelsCard
          metric={metric}
          job={job}
          scope={job === undefined ? "all" : scope}
          expanded={expanded}
          onExpand={(label) => update({ label })}
        />
        <div className="flex flex-col gap-4">
          <MetricRulesCard metric={metric} totalSeries={snapshot.totalSeries} />
          <HistogramPanel metric={metric} />
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
