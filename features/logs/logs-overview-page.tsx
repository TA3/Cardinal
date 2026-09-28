import * as React from "react"
import {
  ArrowClockwiseIcon,
  ChartLineIcon,
  ClockCounterClockwiseIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  ShieldCheckIcon,
  StackIcon,
  TagIcon,
  TrendUpIcon,
  WarningIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"

import { logGroupPath, logLabelPath, paths } from "@/app/paths"
import { CostText, formatCost, useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
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
import { Spinner } from "@/components/ui/spinner"
import { LogsTopSavings } from "@/features/logs/top-savings"
import { stepLabel } from "@/features/logs/volume-parts"
import { takeNextPath } from "@/app/continue-after-connect"
import { ConnectGrafanaCard } from "@/features/grafana/connect-card"
import { ConnectionForm } from "@/features/settings/connection-form"
import {
  authErrorText,
  isAuthError,
  useLogRuleSavings,
  useLogsSnapshotAge,
  useLogsSnapshotProgress,
  useLogsVolumeHistory,
  useRefreshLogsSnapshot,
} from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes, formatBytesDelta, toGB } from "@/lib/core/bytes"
import { bytesPerDay, diffLogsSnapshots, groupNoun, largestGroup, LOGS_RANGE_LABEL, LOGS_RANGES, type LogsGroupChange } from "@/lib/core/logs/snapshot"
import type { LogsRange, LogsSnapshot } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// The logs overview mirrors the metrics one: stat tiles, a volume chart,
// top services and labels, rules, what changed, and the agent.

const RANGE_OPTIONS = LOGS_RANGES.map((value) => ({ value, label: value, title: `Last ${LOGS_RANGE_LABEL[value]}` }))

function formatPercentChange(value: number) {
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
    const next = takeNextPath("logs")
    if (next) navigate(next)
  }
  const hasSource = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  const steps = [
    { icon: MagnifyingGlassIcon, title: "Find", text: "See which services send the most bytes and which labels multiply streams." },
    { icon: FunnelIcon, title: "Cut", text: "Drop noisy lines or move ID-like labels, then export collector config." },
    { icon: RobotIcon, title: "Delegate", text: "Let an AI agent over MCP propose rules." },
  ]
  return (
    <Page>
      <PageHeader
        title={hasSource ? "Take a logs snapshot" : "Connect a logs source"}
        description="Stream and volume stats from Loki's index, never your log lines. Nothing is stored."
      />
      <Stagger className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Reveal>
          <Frame>
            <FrameHeader title="Loki" meta="Grafana Cloud Logs, Loki, or a Grafana data source" />
            <FrameWell className="py-5">
              <ConnectionForm signal="logs" onConnected={continueAfterConnect} />
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

function VolumeFrame({ range, snapshot }: { range: LogsRange; snapshot: LogsSnapshot }) {
  const { data, isPending, error } = useLogsVolumeHistory(range)
  const savings = useLogRuleSavings()
  // Rule impacts are measured over the snapshot's range, so the ratio is too.
  const ratio = snapshot.totals.bytes > 0 ? Math.max(0, 1 - savings.savedBytes / snapshot.totals.bytes) : 1

  const { points, series } = React.useMemo(() => {
    const showProjection = savings.savedBytes > 0
    const chartSeries: ChartSeries[] = [
      { key: "bytes", label: "Ingested", color: "var(--brand)", fill: true },
      ...(showProjection ? [{ key: "projected", label: "After rules (estimate)", color: "var(--muted-foreground)", dashed: true }] : []),
    ]
    const chartPoints: ChartPoint[] = (data?.points ?? []).map((point) => ({
      t: point.t,
      values: { bytes: point.value, ...(showProjection ? { projected: Math.round(point.value * ratio) } : {}) } }))
    return { points: chartPoints, series: chartSeries }
  }, [data, savings.savedBytes, ratio])

  const step = data ? stepLabel(data.stepSeconds) : null
  const values = points.map((point) => point.values.bytes ?? 0)
  const last = values.at(-1)
  const first = values[0]
  const change = first !== undefined && last !== undefined ? last - first : null
  return (
    <Frame>
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <ChartLineIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Volume</span>
          <InfoTip label="How volume is measured" className="-ml-1">
              Bytes ingested per {step ?? "step"}, estimated from Loki's index (index/volume_range) for streams with a {snapshot.groupLabel} label. Chunks
              that span steps make it approximate; the step still being written is left out. {BYTES_NOTE}.
          </InfoTip>
          {last !== undefined ? (
            <span className="tabular-nums">
              <AnimatedNumber value={last} format={formatBytes} /> <span className="text-muted-foreground">per {step}</span>
            </span>
          ) : null}
          {change !== null && first ? (
            <span className="text-muted-foreground tabular-nums">
              <SwapText value={`${formatPercentChange((change / first) * 100)} over ${LOGS_RANGE_LABEL[range]}`} />
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <LegendItem color="var(--brand)">Ingested</LegendItem>
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
            Loading volume…
          </div>
        ) : error || points.length < 2 ? (
          <div className="flex h-80 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground">
            <span>
              {isAuthError(error)
                ? authErrorText(error, "logs")
                : "Volume over time needs Loki's index/volume_range API (Loki 2.9+ with volume_enabled)."}
            </span>
            {error && !isAuthError(error) ? <span className="text-xs">{error.message}</span> : null}
          </div>
        ) : (
          <FadeIn>
            <SeriesChart
              key={range}
              data={points}
              series={series}
              yMin={0}
              formatValue={formatBytes}
              formatAxis={(value) => formatBytes(value, { digits: value >= 1024 && value < 10 * 1024 ** 4 ? 0 : undefined })}
              formatTick={(t) =>
                range === "7d"
                  ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                  : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
              }
            />
          </FadeIn>
        )}
      </FrameWell>
    </Frame>
  )
}

function RulesFrame({ snapshot }: { snapshot: LogsSnapshot }) {
  const savings = useLogRuleSavings()
  const { price } = useBytesCost()
  const total = snapshot.totals.bytes
  const percent = savings.percent
  const savedPerDay = total > 0 ? (savings.savedBytes / total) * bytesPerDay(snapshot) : 0
  return (
    <Frame className="h-full">
      <FrameHeader icon={ShieldCheckIcon} title="Your plan" action={<FrameLink to={paths.rules}>Open</FrameLink>} />
      <FrameWell className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-medium tracking-tight tabular-nums" title={BYTES_NOTE}>
            {savings.isEstimate ? "~" : ""}
            <AnimatedNumber value={savedPerDay} format={(value) => (value > 0 ? `−${formatBytes(value)}` : "0 B")} />
            <span className="ml-1 text-sm font-normal text-muted-foreground">/day</span>
          </span>
          <span className="text-sm text-muted-foreground">
            <SwapText value={`${percent.toFixed(1)}% of ingest`} />
          </span>
        </div>
        {price !== undefined ? (
          savedPerDay > 0 ? <CostText bytes={savedPerDay} per="day" suffix="saved" className="-mt-2" /> : null
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
              Active <span className="text-muted-foreground/60">· {savings.measured} measured</span>
            </span>
            <span className="tabular-nums">{savings.active}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              Proposed <span className="text-muted-foreground/60">· awaiting review</span>
            </span>
            <span className="tabular-nums">{savings.proposed}</span>
          </div>
        </div>
      </FrameWell>
    </Frame>
  )
}

function LabelsFrame({ snapshot }: { snapshot: LogsSnapshot }) {
  return (
    <Frame className="h-full">
      <FrameHeader
        icon={TagIcon}
        title="Labels"
        meta="by distinct values"
        action={<FrameLink to={paths.logLabels} />}
      />
      <FrameWell>
        {snapshot.labels.length ? (
          <ExpandableList
            rows={snapshot.labels.slice(0, 20).map((label) => ({
              label: label.label,
              mono: true,
              value: `${label.idLike ? "ID-like · " : ""}${formatNumber(label.distinctValues)}${snapshot.labelsTruncated && label.distinctValues >= 10_000 ? "+" : ""}`,
              to: logLabelPath(label.label),
              leading: (
                <span
                  title={label.idLike ? "Values look like IDs: a candidate for structured metadata" : undefined}
                  className={cn("size-1.5 shrink-0 rounded-full", label.idLike ? "bg-brand" : "bg-foreground/25")}
                />
              ) }))}
          />
        ) : (
          <EmptyState compact icon={TagIcon} title="No stream labels" description="Nothing in this range carries a label besides the internal ones." />
        )}
      </FrameWell>
    </Frame>
  )
}

function ago(capturedAt: string | undefined) {
  if (!capturedAt) return null
  const ms = Date.now() - new Date(capturedAt).getTime()
  if (!Number.isFinite(ms)) return null
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

function ChangeList({ title, items, total, fresh }: { title: string; items: LogsGroupChange[]; total: number; fresh?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{title}</span>
        {total > items.length ? <span className="tabular-nums">+{total - items.length} more</span> : null}
      </div>
      {items.length ? (
        items.map((item) => (
          <Link
            key={item.value}
            to={logGroupPath(item.value)}
            title={fresh ? `${item.value}: new, ${formatBytes(item.after)}` : `${item.value}: ${formatBytes(item.before)} → ${formatBytes(item.after)}`}
            className="-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-1 text-sm outline-none transition-colors hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", fresh ? "bg-brand" : "bg-brand/50")} />
            <span className="min-w-0 flex-1 truncate">{item.value}</span>
            <span className="shrink-0 text-brand-ink tabular-nums">{formatBytesDelta(item.delta)}</span>
          </Link>
        ))
      ) : (
        <p className="py-1 text-sm text-muted-foreground">None</p>
      )}
    </div>
  )
}

function SinceLastFrame({ snapshot }: { snapshot: LogsSnapshot }) {
  const previous = useAppStore((state) => state.previousLogsSnapshotSummary)
  const diff = React.useMemo(() => (previous ? diffLogsSnapshots(previous, snapshot) : null), [previous, snapshot])
  const when = ago(previous?.capturedAt)
  const noun = groupNoun(snapshot.groupLabel)
  return (
    <Frame className="h-full">
      <FrameHeader icon={ClockCounterClockwiseIcon} title="Since last snapshot" meta={when ? `vs ${when}` : undefined} />
      <FrameWell className="flex flex-col gap-3">
        {!previous || !diff ? (
          <EmptyState compact icon={TrendUpIcon} title="One snapshot so far" description={`Refresh later to see which ${noun} grew and which are new.`} />
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className={cn("text-2xl font-medium tracking-tight tabular-nums", diff.bytesDelta > 0 && "text-brand-ink")}>
                <SwapText value={formatBytesDelta(diff.bytesDelta)} />
                <span className="ml-1 text-sm font-normal text-muted-foreground">/day</span>
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {formatNumber(previous.totals.streams)} → {formatNumber(snapshot.totals.streams)} streams
              </span>
            </div>
            {diff.comparable ? (
              <>
                <ChangeList title="Grew most" items={diff.growers.slice(0, 5)} total={diff.growers.length} />
                <ChangeList title={`New ${noun}`} items={diff.added.slice(0, 5)} total={diff.added.length} fresh />
                {diff.gone ? (
                  <p className="text-xs text-muted-foreground">
                    {diff.gone} {diff.gone === 1 ? groupNoun(snapshot.groupLabel, false) : noun} no longer sending logs.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                The previous snapshot covered {previous.range} grouped by {previous.groupLabel}; per-{groupNoun(snapshot.groupLabel, false)} changes need the same range
                and grouping. The total is compared per day.
              </p>
            )}
          </>
        )}
      </FrameWell>
    </Frame>
  )
}

const AGENT_FACTS = [
  { text: "Queries run in this tab; your token never leaves it." },
  { text: "It only proposes rules. Nothing changes until you accept." },
  { text: "Ask “which services log the most, and what can I drop?” to start." },
]

function AgentFrame() {
  const status = useAppStore((state) => state.agentStatus)
  const activity = useAppStore((state) => state.agentActivity)
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
            <p className="flex items-center gap-1 text-muted-foreground">
              Let Claude find the noisiest logs over MCP. It proposes; you decide.
              <InfoTip label="How the agent works">
                <ul className="flex flex-col gap-1">
                  {AGENT_FACTS.map((fact) => (
                    <li key={fact.text}>{fact.text}</li>
                  ))}
                </ul>
              </InfoTip>
            </p>
            <div className="mt-auto pt-1">
              <Button asChild variant="outline" size="sm">
                <Link to={paths.agent}>
                  <RobotIcon data-icon="inline-start" />
                  Start agent session
                </Link>
              </Button>
            </div>
          </div>
        )}
      </FrameWell>
    </Frame>
  )
}

function SnapshotStatus({ refreshing, snapshot }: { refreshing: boolean; snapshot: LogsSnapshot }) {
  const age = useLogsSnapshotAge()
  const progress = useLogsSnapshotProgress()
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
        {age.host ? ` · ${age.host}` : ""} · last {snapshot.range} by {snapshot.groupLabel}
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

function Dashboard({ snapshot }: { snapshot: LogsSnapshot }) {
  const refresh = useRefreshLogsSnapshot()
  const range = useAppStore((state) => state.logsSettings.range)
  const { price, cost } = useBytesCost()
  const perDay = bytesPerDay(snapshot)
  const top = largestGroup(snapshot)
  const noun = groupNoun(snapshot.groupLabel)
  const dayCost = cost(perDay)

  return (
    <Page>
      <PageHeader
        title="Overview"
        status={
          <>
            <LiveDot className="size-2" />
            <AnimatedNumber value={snapshot.totals.streams} />
            <span className="font-normal">streams</span>
          </>
        }
        description={<SnapshotStatus refreshing={refresh.isPending} snapshot={snapshot} />}
        actions={
          <>
            <SegmentedControl
              aria-label="Snapshot range"
              value={range}
              onValueChange={(next) => {
                if (next !== range) refresh.refresh({ range: next })
              }}
              options={RANGE_OPTIONS}
            />
            <Button variant="inverse" onClick={() => refresh.refresh()} disabled={refresh.isPending}>
              {refresh.isPending ? <Spinner data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
              {refresh.isPending ? "Refreshing" : "Refresh"}
              <Kbd className="ml-0.5 bg-background/15 text-background">R</Kbd>
            </Button>
          </>
        }
      />

      <Stagger className="flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Reveal className="min-w-0">
            <LogsTopSavings snapshot={snapshot} />
          </Reveal>
          <Reveal>
            <RulesFrame snapshot={snapshot} />
          </Reveal>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Reveal>
            <StatFrame
              label="Streams"
              value={<AnimatedNumber value={snapshot.totals.streams} />}
              hint={snapshot.totals.lines ? `${formatNumber(snapshot.totals.lines)} lines` : undefined}
            />
          </Reveal>
          <Reveal>
            <StatFrame
              label="Ingest per day"
              value={<AnimatedNumber value={perDay} format={formatBytes} />}
              hint={<span title={BYTES_NOTE}>{`${formatBytes(snapshot.totals.bytes)} in last ${snapshot.range}`}</span>}
            />
          </Reveal>
          <Reveal>
            <StatFrame
              label="Label names"
              value={<AnimatedNumber value={snapshot.totals.labelCount} />}
              hint={`${formatNumber(snapshot.groupCount ?? snapshot.groups.length)} ${noun}`}
            />
          </Reveal>
          <Reveal>
            <StatFrame
              label={`Largest ${groupNoun(snapshot.groupLabel, false)}`}
              value={
                top ? (
                  <Link
                    to={logGroupPath(top.value)}
                    title={`${top.value}: ${top.share.toFixed(1)}% of ingested bytes`}
                    className="flex min-w-0 items-baseline gap-2 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <AnimatedNumber value={top.share} format={(value) => `${Math.round(value)}%`} />
                    <span className="truncate text-sm font-normal text-muted-foreground">{top.value}</span>
                  </Link>
                ) : (
                  "—"
                )
              }
              hint={top ? `${formatBytes(top.bytes)} · ${formatNumber(top.streams)} streams` : undefined}
            />
          </Reveal>
          <Reveal className="col-span-2 lg:col-span-1">
            <StatFrame
              label="Cost per day"
              value={dayCost === null ? "—" : <AnimatedNumber value={dayCost} format={formatCost} />}
              hint={
                price === undefined ? (
                  <Link to={paths.settings} className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Set a price per GB
                  </Link>
                ) : (
                  `≈ ${formatCost(toGB(perDay) * price * 30)}/mo at ${formatCost(price)}/GB`
                )
              }
            />
          </Reveal>
        </div>

        <Reveal>
          <VolumeFrame range={range} snapshot={snapshot} />
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Reveal>
            <Frame className="h-full">
              <FrameHeader
                icon={StackIcon}
                title={`Top ${noun}`}
                meta={
                  <span title={BYTES_NOTE}>
                    {snapshot.range}
                    {snapshot.groupsTruncated ? ` · of ${formatNumber(snapshot.groupCount ?? 0)}` : ""}
                  </span>
                }
                action={<FrameLink to={paths.logStreams} />}
              />
              <FrameWell>
                {snapshot.groups.length ? (
                  <ExpandableList
                    rows={snapshot.groups.slice(0, 12).map((group) => ({
                      label: group.value,
                      value: formatBytes(group.bytes),
                      percent: group.share,
                      to: logGroupPath(group.value),
                      leading: <span className="size-1.5 shrink-0 rounded-full bg-foreground/25" /> }))}
                  />
                ) : (
                  <EmptyState compact icon={StackIcon} title={`No volume for ${snapshot.groupLabel}`} description="Loki's index has no bytes for it in this range." />
                )}
              </FrameWell>
            </Frame>
          </Reveal>
          <Reveal>
            <LabelsFrame snapshot={snapshot} />
          </Reveal>
          <Reveal>
            <SinceLastFrame snapshot={snapshot} />
          </Reveal>
          <Reveal className="xl:col-span-3">
            <AgentFrame />
          </Reveal>
        </div>
      </Stagger>
    </Page>
  )
}

export function LogsOverviewPage() {
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const hasSource = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  // A snapshot from a connection that was since removed doesn't show.
  return snapshot && hasSource ? <Dashboard snapshot={snapshot} /> : <Welcome />
}
