import * as React from "react"
import {
  ArrowClockwiseIcon,
  BriefcaseIcon,
  ChartLineIcon,
  CubeIcon,
  FunnelIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TagIcon,
  WarningIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"

import { jobPath, metricPath, paths } from "@/app/paths"
import { CostText, useCost } from "@/components/cost-text"
import { Frame, FrameHeader, FrameLink, FrameWell, StatFrame } from "@/components/frame"
import { ExpandableList, ListRow } from "@/components/list-rows"
import { InfoTip } from "@/components/info-tip"
import { AnimatedNumber, FadeIn, LiveDot, Reveal, Stagger, SwapText } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { SegmentedControl } from "@/components/segmented-control"
import { SeriesChart, type ChartPoint, type ChartSeries } from "@/components/series-chart"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ChurnCard } from "@/features/churn/churn-card"
import { SinceLastFrame } from "@/features/overview/since-last-frame"
import { takeNextPath } from "@/app/continue-after-connect"
import { ConnectGrafanaCard } from "@/features/grafana/connect-card"
import { ConnectionForm } from "@/features/settings/connection-form"
import {
  isAuthError,
  useIsGrafanaCloud,
  useRefreshSnapshot,
  useRuleCounts,
  useSavings,
  useSeriesHistory,
  useSnapshotAge,
  useSnapshotProgress,
  useTsdbStatus } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { jobLabel } from "@/lib/core/jobs"
import type { Snapshot } from "@/lib/core/snapshot"
import type { HistoryRange } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

const RANGE_LABEL: Record<HistoryRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" }
const RANGE_OPTIONS = (Object.keys(RANGE_LABEL) as HistoryRange[]).map((value) => ({ value, label: value, title: `Last ${RANGE_LABEL[value]}` }))

function formatPercentChange(value: number) {
  // Small changes keep two decimals so they don't read as exactly zero.
  const digits = Math.abs(value) < 0.1 ? 2 : 1
  const text = Math.abs(value).toFixed(digits)
  if (!Number.isFinite(value) || Number(text) === 0) return "0%"
  return `${value > 0 ? "+" : "−"}${text}%`
}

function LegendItem({ color, dashed, children }: { color: string; dashed?: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden width="14" height="2" className="shrink-0 overflow-visible">
        <line x1="0" x2="14" y1="1" y2="1" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={dashed ? "3 3" : undefined} />
      </svg>
      {children}
    </span>
  )
}

function Welcome() {
  const navigate = useNavigate()
  // A deep link opened without a connection continues there once connected.
  const continueAfterConnect = () => {
    const next = takeNextPath("metrics")
    if (next) navigate(next)
  }
  const steps = [
    { icon: MagnifyingGlassIcon, title: "Find", text: "One snapshot shows which jobs, metrics and labels make up your active series." },
    { icon: FunnelIcon, title: "Cut", text: "Pick what to drop with exact savings, then export relabel or Adaptive Metrics rules." },
    { icon: RobotIcon, title: "Delegate", text: "Connect an AI agent over MCP to investigate and propose rules for you." },
  ]
  return (
    <Page>
      <PageHeader
        title="Connect a data source"
        description="Cardinal reads active series from any Prometheus-compatible API. Queries run from this tab. In proxy mode they pass through Cardinal's Worker; nothing is stored."
      />
      <Stagger className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Reveal>
          <Frame>
            <FrameHeader title="Prometheus" meta="Prometheus, Mimir or Grafana Cloud Metrics" />
            <FrameWell className="py-5">
              <ConnectionForm onConnected={continueAfterConnect} />
            </FrameWell>
          </Frame>
        </Reveal>
        <div className="flex flex-col gap-4">
          <Reveal>
            <ConnectGrafanaCard />
          </Reveal>
          {steps.map((step) => (
            <Reveal key={step.title}>
              <Frame>
                <FrameHeader icon={step.icon} title={step.title} />
                <FrameWell className="text-sm text-muted-foreground">{step.text}</FrameWell>
              </Frame>
            </Reveal>
          ))}
        </div>
      </Stagger>
    </Page>
  )
}

function HistoryFrame({ range, totalNow }: { range: HistoryRange; totalNow: number }) {
  const { data, isPending, error } = useSeriesHistory(range)
  const savings = useSavings()
  const ratio = totalNow > 0 ? 1 - savings.savedSeries / totalNow : 1

  const { points, series } = React.useMemo(() => {
    const showProjection = savings.savedSeries > 0
    const chartSeries: ChartSeries[] = [
      { key: "series", label: "Active series", color: "var(--brand)", fill: true },
      ...(showProjection ? [{ key: "projected", label: "After rules (estimate)", color: "var(--muted-foreground)", dashed: true }] : []),
    ]
    const chartPoints: ChartPoint[] = (data?.points ?? []).map((point) => ({
      t: point.t,
      values: { series: point.value, ...(showProjection ? { projected: Math.round(point.value * ratio) } : {}) } }))
    return { points: chartPoints, series: chartSeries }
  }, [data, savings.savedSeries, ratio])

  const hourly = range === "24h"
  const first = points[0]?.values.series
  const last = points[points.length - 1]?.values.series
  const change = first !== undefined && last !== undefined ? last - first : null
  return (
    <Frame>
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <ChartLineIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">History</span>
          <InfoTip label="Why History differs from the snapshot count" className="-ml-1">
              History uses prometheus_tsdb_head_series, the series in the TSDB head (including ones that stopped recently). The snapshot counts
              series visible to queries right now, so the two rarely match exactly.
          </InfoTip>
          {last !== undefined ? (
            <span className="tabular-nums">
              <AnimatedNumber value={last} /> <span className="text-muted-foreground">now</span>
            </span>
          ) : null}
          {change !== null && first ? (
            <span className="text-muted-foreground tabular-nums">
              <SwapText value={`${formatDelta(change)} (${formatPercentChange((change / first) * 100)}) over ${RANGE_LABEL[range]}`} />
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <LegendItem color="var(--brand)">Active series</LegendItem>
          {series.length > 1 ? (
            <LegendItem color="var(--muted-foreground)" dashed>
              After rules (estimate)
            </LegendItem>
          ) : null}
        </div>
      </div>
      <FrameWell className="px-2 py-2">
        {isPending ? (
          <div className="flex h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading history…
          </div>
        ) : error || points.length < 2 ? (
          <div className="flex h-80 flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <span>
              {isAuthError(error)
                ? "Unauthorized: the backend rejected the request (HTTP 401). Enter your token to load history."
                : "Series history isn't available from this backend."}
            </span>
            {error && !isAuthError(error) ? <span className="text-xs">{error.message}</span> : null}
          </div>
        ) : (
          <FadeIn>
            <SeriesChart
              key={range}
              data={points}
              series={series}
              formatTick={(t) =>
                hourly
                  ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                  : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              }
            />
          </FadeIn>
        )}
      </FrameWell>
    </Frame>
  )
}

function RulesFrame({ totalSeries }: { totalSeries: number }) {
  const rules = useAppStore((state) => state.rules)
  const savings = useSavings()
  const { price } = useCost()
  const counts = useRuleCounts()
  const active = rules.filter((rule) => rule.status === "active")
  const saved = (kind: "drop_metric" | "drop_labels") =>
    active.filter((rule) => rule.kind === kind).reduce((sum, rule) => sum + (rule.impact ? rule.impact.seriesBefore - rule.impact.seriesAfter : 0), 0)
  const metricDrops = active.filter((rule) => rule.kind === "drop_metric")
  const labelDrops = active.filter((rule) => rule.kind === "drop_labels")
  const aggregation = active.filter((rule) => rule.impact?.mergesSeries).length

  return (
    <Frame className="h-full">
      <FrameHeader icon={ShieldCheckIcon} title="Rules" action={<FrameLink to={paths.rules} />} />
      <FrameWell className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-medium tracking-tight tabular-nums">
            {savings.isEstimate ? "~" : ""}
            <AnimatedNumber value={savings.savedSeries} format={(value) => formatDelta(-value)} />
          </span>
          <span className="text-sm text-muted-foreground">
            <SwapText value={`${savings.percent.toFixed(1)}% of ${formatNumber(totalSeries)}`} />
          </span>
        </div>
        {price !== undefined ? (
          savings.savedSeries > 0 ? <CostText series={savings.savedSeries} suffix="saved" className="-mt-2" /> : null
        ) : (
          <Link
            to={paths.settings}
            className="-mt-2 self-start rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Set price to see cost
          </Link>
        )}
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              Metric drops <span className="text-muted-foreground/60">· {metricDrops.length}</span>
            </span>
            <span className="tabular-nums">{formatDelta(-saved("drop_metric"))}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              Label drops <span className="text-muted-foreground/60">· {labelDrops.length}</span>
            </span>
            <span className="tabular-nums">{formatDelta(-saved("drop_labels"))}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              Proposed <span className="text-muted-foreground/60">· awaiting review</span>
            </span>
            <span className="tabular-nums">{counts.proposed}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {aggregation
            ? `${aggregation} label drop${aggregation === 1 ? "" : "s"} merge series and ship as Adaptive Metrics aggregations only.`
            : active.length
              ? "All rules can ship as relabel config."
              : "Drop metrics or labels while exploring, or let an agent propose rules."}
        </p>
      </FrameWell>
    </Frame>
  )
}

function LabelsFrame() {
  const { data, isPending, error } = useTsdbStatus()
  // __name__ counts metrics, which the Metrics card already covers.
  const labels = data?.labelValueCountByLabelName?.filter((item) => item.name !== "__name__") ?? []
  return (
    <Frame className="h-full">
      <FrameHeader icon={TagIcon} title="Labels" meta="by distinct values" />
      <FrameWell>
        {isPending ? (
          <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-5" />
            ))}
          </div>
        ) : error || !labels.length ? (
          <p className="py-2 text-sm text-muted-foreground">
            {isAuthError(error)
              ? "Unauthorized (HTTP 401). Enter your token to load label stats."
              : "Instance-wide label stats need Prometheus' TSDB status API. Open a metric to see its labels."}
          </p>
        ) : (
          <ExpandableList
            rows={labels.map((item) => ({ label: item.name, value: formatNumber(item.value), mono: true }))}
          />
        )}
      </FrameWell>
    </Frame>
  )
}

const AGENT_FACTS = [
  { icon: LockKeyIcon, text: "Queries run in this tab; your token never leaves it." },
  { icon: ShieldCheckIcon, text: "It only proposes rules. Nothing changes until you accept." },
  { icon: SparkleIcon, text: "Ask “what's driving my series count?” to start." },
]

function AgentFrame() {
  const status = useAppStore((state) => state.agentStatus)
  const activity = useAppStore((state) => state.agentActivity)
  const cloud = useIsGrafanaCloud()
  const live = status === "connected"
  return (
    <Frame className="h-full">
      <FrameHeader
        icon={RobotIcon}
        title="Agent"
        meta={
          live ? (
            <span className="inline-flex items-center gap-1.5 text-brand-ink">
              <LiveDot className="size-1.5" />
              live
            </span>
          ) : undefined
        }
        action={<FrameLink to={paths.agent}>{live ? "Open" : "Set up"}</FrameLink>}
      />
      <FrameWell>
        {activity.length ? (
          <div className="flex flex-col">
            {activity.slice(0, 5).map((item, index) => (
              <ListRow
                key={`${item.at}-${index}`}
                leading={<LiveDot pulse={false} className={item.ok ? "size-1.5 text-brand/60" : "size-1.5 text-destructive"} />}
                label={item.tool}
                mono
                value={new Date(item.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col gap-3 py-1 text-sm">
            <p className="text-muted-foreground">Start an MCP session and let Claude find what to cut. It proposes; you decide.</p>
            <ul className="flex flex-col gap-2 xl:flex-row xl:gap-8">
              {AGENT_FACTS.map((fact) => (
                <li key={fact.text} className="flex items-start gap-2.5">
                  <fact.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{fact.text}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
              <Button asChild variant="outline" size="sm">
                <Link to={paths.agent}>
                  <RobotIcon data-icon="inline-start" />
                  Start agent session
                </Link>
              </Button>
              {cloud ? (
                <Link to={paths.recommendations} className="inline-flex items-center gap-1.5 rounded-sm text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                  <SparkleIcon className="size-4 text-brand" />
                  Or review Adaptive Metrics recommendations
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </FrameWell>
    </Frame>
  )
}

/** "Snapshot 3 min ago", with a stale hint after a day, or the running refresh's progress. */
function SnapshotStatus({ refreshing }: { refreshing: boolean }) {
  const age = useSnapshotAge()
  const progress = useSnapshotProgress()
  if (refreshing) {
    const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null
    return (
      <span key="progress" role="status" className="flex max-w-md flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          <SwapText value={progress?.phase ?? "Taking a snapshot"} />
          {percent !== null ? (
            <span className="tabular-nums">
              {progress!.done.toLocaleString()} / {progress!.total.toLocaleString()}
            </span>
          ) : null}
        </span>
        {percent !== null ? <Progress value={percent} aria-label="Snapshot progress" className="h-1" /> : null}
      </span>
    )
  }
  if (!age) return null
  return (
    <span key="age" className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span title={age.capturedAt.toLocaleString()}>
        Snapshot <SwapText value={age.label} />
        {age.host ? ` · ${age.host}` : ""}
      </span>
      {age.stale ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
          <WarningIcon className="size-3" />
          Stale: press R to refresh
        </span>
      ) : null}
    </span>
  )
}

function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const refresh = useRefreshSnapshot()
  const [range, setRange] = React.useState<HistoryRange>("7d")
  const topJob = React.useMemo(
    () => snapshot.jobs.reduce<Snapshot["jobs"][number] | undefined>((best, job) => (!best || job.seriesCount > best.seriesCount ? job : best), undefined),
    [snapshot]
  )

  return (
    <Page>
      <PageHeader
        title="Overview"
        status={
          <>
            <LiveDot className="size-2" />
            <AnimatedNumber value={snapshot.totalSeries} />
            <span className="font-normal">series</span>
          </>
        }
        description={<SnapshotStatus refreshing={refresh.isPending} />}
        actions={
          <>
            <SegmentedControl aria-label="History range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />
            <Button variant="inverse" onClick={refresh.refresh} disabled={refresh.isPending}>
              {refresh.isPending ? <Spinner data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
              {refresh.isPending ? "Refreshing" : "Refresh"}
              <Kbd className="ml-0.5 bg-background/15 text-background">R</Kbd>
            </Button>
          </>
        }
      />

      <Stagger className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Reveal>
            <StatFrame label="Active series" value={<AnimatedNumber value={snapshot.totalSeries} />} hint={<CostText series={snapshot.totalSeries} />} />
          </Reveal>
          <Reveal>
            <StatFrame label="Metrics" value={<AnimatedNumber value={snapshot.metricCount} />} />
          </Reveal>
          <Reveal>
            <StatFrame label="Jobs" value={<AnimatedNumber value={snapshot.jobs.length} />} />
          </Reveal>
          <Reveal>
            <StatFrame label="Label names" value={snapshot.labelCount === null ? "—" : <AnimatedNumber value={snapshot.labelCount} />} />
          </Reveal>
          <Reveal className="col-span-2 lg:col-span-1">
            <StatFrame
              label="Largest job"
              value={
                topJob ? (
                  <Link to={jobPath(topJob.job)} title={`${jobLabel(topJob.job)}: ${topJob.percentageOfTotal.toFixed(1)}% of all series`} className="flex min-w-0 items-baseline gap-2 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    <AnimatedNumber value={topJob.percentageOfTotal} format={(value) => `${Math.round(value)}%`} />
                    <span className="truncate text-sm font-normal text-muted-foreground">{jobLabel(topJob.job)}</span>
                  </Link>
                ) : (
                  "—"
                )
              }
            />
          </Reveal>
        </div>

        <Reveal>
          <HistoryFrame range={range} totalNow={snapshot.totalSeries} />
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Reveal>
            <Frame className="h-full">
              <FrameHeader icon={CubeIcon} title="Top metrics" action={<FrameLink to={paths.explore} />} />
              <FrameWell>
                <ExpandableList
                  rows={snapshot.metrics.slice(0, 12).map((metric) => ({
                    label: metric.metric,
                    mono: true,
                    value: formatNumber(metric.seriesCount),
                    percent: metric.percentageOfTotal,
                    to: metricPath(metric.metric) }))}
                />
              </FrameWell>
            </Frame>
          </Reveal>
          <Reveal>
            <Frame className="h-full">
              <FrameHeader icon={BriefcaseIcon} title="Jobs" action={<FrameLink to={paths.jobs} />} />
              <FrameWell>
                <ExpandableList
                  rows={snapshot.jobs.map((job) => ({
                    label: jobLabel(job.job),
                    value: formatNumber(job.seriesCount),
                    percent: job.percentageOfTotal,
                    to: jobPath(job.job),
                    muted: job.job === "",
                    leading: <span className="size-1.5 shrink-0 rounded-full bg-foreground/25" /> }))}
                />
              </FrameWell>
            </Frame>
          </Reveal>
          <Reveal className="md:col-span-2 xl:col-span-1">
            <RulesFrame totalSeries={snapshot.totalSeries} />
          </Reveal>
          <Reveal>
            <LabelsFrame />
          </Reveal>
          <Reveal>
            <SinceLastFrame snapshot={snapshot} />
          </Reveal>
          <Reveal>
            <ChurnCard />
          </Reveal>
          <Reveal className="xl:col-span-3">
            <AgentFrame />
          </Reveal>
        </div>
      </Stagger>
    </Page>
  )
}

export function OverviewPage() {
  const snapshot = useAppStore((state) => state.snapshot)
  return snapshot ? <Dashboard snapshot={snapshot} /> : <Welcome />
}
