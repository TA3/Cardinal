import * as React from "react"
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ChartLineIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  FunnelIcon,
  HardDrivesIcon,
  PercentIcon,
  TrendUpIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { Link } from "react-router"

import { logGroupPath, logLabelPath, paths } from "@/app/paths"
import { formatCost, useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell, StatFrame } from "@/components/frame"
import { InfoTip } from "@/components/info-tip"
import { AnimatedNumber, FadeIn, Reveal, Stagger, SwapText } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { SeriesChart, type ChartPoint, type ChartSeries } from "@/components/series-chart"
import { ShareBar } from "@/components/share-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Term } from "@/features/rules/term"
import { Combobox } from "@/components/combobox"
import { groupLink } from "@/features/logs/streams-shared"
import { useVerifiedGrowth, useVolumeBreakdown, useVolumeSeries } from "@/features/logs/volume-data"
import { formatTickFor, SERIES_COLOR_VARS, SERIES_COLORS, stepLabel } from "@/features/logs/volume-parts"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { authErrorText, isAuthError } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes, formatBytesDelta, toGB } from "@/lib/core/bytes"
import { groupNoun, LOGS_RANGE_LABEL, LOGS_RANGES } from "@/lib/core/logs/snapshot"
import type { LogsRange, LogsSnapshot } from "@/lib/core/logs/types"
import {
  compareVolumes,
  formatGrowth,
  growthPercent,
  perDay,
  streamChange,
  topGrowers,
  volumeTotals,
  type VolumeRow,
} from "@/lib/core/logs/volume"
import { cn } from "@/lib/utils"

// Volume: bytes by a chosen label over a range, against the range before it.
// Everything comes from Loki's index (cheap, but an estimate); the top growers
// are re-checked with bytes_over_time over one hour.

const RANGE_OPTIONS = LOGS_RANGES.map((value) => ({ value, label: value, title: `Last ${LOGS_RANGE_LABEL[value]} vs the ${LOGS_RANGE_LABEL[value]} before` }))
const SHOWN = 25
const NO_VALUE = "(no value)"

const ESTIMATE_NOTE = `Estimated from Loki's index (index/volume), which reads higher than the bytes in the lines (bytes_over_time), most in the newest hours. ${BYTES_NOTE}.`

function valueLabel(value: string) {
  return value === "" ? NO_VALUE : value
}

function GrowthBadge({ row }: { row: VolumeRow }) {
  const text = formatGrowth(row.growth, row.trend)
  if (row.grower) {
    return (
      <Badge variant="outline" className="border-brand/40 text-brand-ink tabular-nums" title={row.delta !== null ? `${formatBytesDelta(row.delta)} vs the previous period` : undefined}>
        {row.trend === "new" ? "new" : text}
      </Badge>
    )
  }
  return (
    <span className={cn("text-xs tabular-nums", row.trend === "gone" ? "text-muted-foreground italic" : "text-muted-foreground")} title={row.delta !== null ? `${formatBytesDelta(row.delta)} vs the previous period` : undefined}>
      {text}
    </span>
  )
}

function RowActions({ row, by, groupLabel, range }: { row: VolumeRow; by: string; groupLabel: string; range: LogsRange }) {
  const propose = useProposeLogRule()
  if (row.value === "") return null
  const selector = { matchers: [{ label: by, op: "=" as const, value: row.value }] }
  const share = `${row.share.toFixed(1)}% of logs volume (${formatBytes(row.bytes)} in the last ${range})`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-reveal size="icon-xs" variant="ghost" aria-label={`Actions for ${row.value}`}>
          <DotsThreeIcon weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate font-mono text-xs">
          {by}="{row.value}"
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link to={by === groupLabel ? logGroupPath(row.value) : logLabelPath(by)}>
            <ArrowSquareOutIcon />
            {by === groupLabel ? `Open ${groupNoun(groupLabel, false)}` : `Open label ${by}`}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            propose({
              kind: "sample",
              selector,
              keep: 0.1,
              origin: "user",
              rationale: `${by}="${row.value}" is ${share}. Keeping 10% of its lines cuts about 90% of that.`,
            })
          }
        >
          <PercentIcon />
          Propose: sample to 10%
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            propose({
              kind: "drop_lines",
              selector,
              line: { levels: ["debug", "trace"] },
              origin: "user",
              rationale: `${by}="${row.value}" is ${share}. Debug and trace lines are rarely needed in production.`,
            })
          }
        >
          <FunnelIcon />
          Propose: drop debug and trace lines
        </DropdownMenuItem>
        {by === groupLabel ? (
          <DropdownMenuItem asChild>
            <Link to={`${paths.logPatterns}?service=${encodeURIComponent(row.value)}`}>
              <ChartLineIcon />
              See its patterns
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function VolumeTable({ rows, by, groupLabel, range, colors }: { rows: VolumeRow[]; by: string; groupLabel: string; range: LogsRange; colors: Map<string, string> }) {
  const [all, setAll] = React.useState(false)
  const shown = all ? rows : rows.slice(0, SHOWN)
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>{by}</TableHead>
          <TableHead className="w-[4.5rem] text-right sm:w-24" title={`Bytes over the range. ${BYTES_NOTE}`}>
            Bytes
          </TableHead>
          <TableHead className="hidden w-40 sm:table-cell">Share</TableHead>
          <TableHead className="w-16 text-right sm:w-20">Change</TableHead>
          <TableHead className="w-8 sm:w-10">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((row, index) => {
          const color = colors.get(row.value)
          return (
            <TableRow
              key={row.value}
              className={cn("animate-blur-in", row.grower && "bg-brand/[0.04] hover:bg-brand/[0.07]")}
              style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
            >
              <TableCell className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-full", !color && (row.grower ? "bg-brand/60" : "bg-foreground/20"))}
                    style={color ? { background: color } : undefined}
                  />
                  {row.value !== "" ? (
                    <Link
                      to={by === groupLabel ? logGroupPath(row.value) : groupLink(row.value, by)}
                      title={row.value}
                      className="truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {row.value}
                    </Link>
                  ) : (
                    <span className={cn("truncate", row.value === "" && "text-muted-foreground italic")} title={valueLabel(row.value)}>
                      {valueLabel(row.value)}
                    </span>
                  )}
                  {row.grower ? <TrendUpIcon aria-label="Top grower" className="size-3.5 shrink-0 text-brand-ink" /> : null}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.trend === "gone" ? <span className="text-muted-foreground">0 B</span> : formatBytes(row.bytes)}</TableCell>
              <TableCell className="hidden sm:table-cell">
                <ShareBar percent={row.share} />
              </TableCell>
              <TableCell className="text-right">
                <GrowthBadge row={row} />
              </TableCell>
              <TableCell className="text-right">
                <RowActions row={row} by={by} groupLabel={groupLabel} range={range} />
              </TableCell>
            </TableRow>
          )
        })}
        {rows.length > SHOWN ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="text-center">
              <Button size="xs" variant="ghost" onClick={() => setAll((value) => !value)}>
                {all ? "Show fewer" : `Show all ${rows.length.toLocaleString()}`}
              </Button>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

function VolumeChart({ by, range }: { by: string; range: LogsRange }) {
  const { data, isPending, error } = useVolumeSeries(by, range)
  const { points, series } = React.useMemo(() => {
    const keys = data?.keys ?? []
    const chartSeries: ChartSeries[] = keys.map((key, index) => ({ key, label: valueLabel(key), color: SERIES_COLORS[index] }))
    const chartPoints: ChartPoint[] = (data?.points ?? []).map((point) => ({ t: point.t, values: point.values }))
    return { points: chartPoints, series: chartSeries }
  }, [data])

  return (
    <Frame className={SERIES_COLOR_VARS}>
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <ChartLineIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Top {series.length || 5} by {by}</span>
          <span className="text-muted-foreground">per {data ? stepLabel(data.stepSeconds) : "step"}</span>
          <InfoTip label="How the chart is measured">
            Bytes per step from index/volume_range for the five largest values of {by}. The step still being written is left out. {ESTIMATE_NOTE}
          </InfoTip>
        </div>
        {series.length ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
            {series.map((item) => (
              <li key={item.key} className="flex max-w-40 items-center gap-1.5">
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
                <span className="truncate" title={item.label}>
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <FrameWell className="px-2 py-2">
        {isPending ? (
          <div className="flex h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading volume…
          </div>
        ) : error || points.length < 2 ? (
          <div className="flex h-72 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground">
            <span>
              {isAuthError(error)
                ? authErrorText(error, "logs")
                : error
                  ? "Volume over time needs Loki's index/volume_range API (Loki 2.9+ with volume_enabled)."
                  : `Not enough data by ${by} in the last ${LOGS_RANGE_LABEL[range]}.`}
            </span>
            {error && !isAuthError(error) ? <span className="text-xs">{error.message}</span> : null}
          </div>
        ) : (
          <FadeIn>
            <SeriesChart
              key={`${by}-${range}`}
              data={points}
              series={series}
              height={288}
              yMin={0}
              formatValue={formatBytes}
              formatAxis={(value) => formatBytes(value, { digits: value >= 1024 && value < 10 * 1024 ** 4 ? 0 : undefined })}
              formatTick={formatTickFor(range === "7d")}
            />
          </FadeIn>
        )}
      </FrameWell>
    </Frame>
  )
}

function GrowersFrame({ rows, by, range, hasPrevious }: { rows: VolumeRow[]; by: string; range: LogsRange; hasPrevious: boolean }) {
  const growers = React.useMemo(() => topGrowers(rows), [rows])
  const verify = useVerifiedGrowth(by, range, growers.map((row) => row.value))
  const hourNote = range === "1h" ? "last hour vs the hour before" : `last hour vs the same hour ${range === "24h" ? "yesterday" : "last week"}`
  return (
    <Frame>
      <FrameHeader icon={TrendUpIcon} title="Top growers" meta={`vs the previous ${LOGS_RANGE_LABEL[range]}`} />
      <FrameWell className="flex flex-col gap-2">
        {!hasPrevious ? (
          <EmptyState compact icon={TrendUpIcon} title="Nothing to compare with" description={`Loki has no volume for the ${LOGS_RANGE_LABEL[range]} before this one.`} />
        ) : growers.length === 0 ? (
          <EmptyState compact icon={CheckCircleIcon} title="No big growers" description={`No ${by} grew by 10% or more (and 0.5% of volume) over the previous ${LOGS_RANGE_LABEL[range]}.`} />
        ) : (
          <>
            <ul className="flex flex-col">
              {growers.map((row) => {
                const now = verify.data?.now[row.value]
                const before = verify.data?.before[row.value]
                const checked = now !== undefined ? (before ? growthPercent(before, now) : null) : undefined
                return (
                  <li key={row.value} className="flex flex-col gap-0.5 border-b border-well-border/70 py-2 last:border-b-0">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="size-1.5 shrink-0 rounded-full bg-brand" />
                      <span className="min-w-0 flex-1 truncate" title={row.value}>
                        {valueLabel(row.value)}
                      </span>
                      <span className="shrink-0 text-brand-ink tabular-nums">{formatBytesDelta(row.delta ?? 0)}</span>
                      <GrowthBadge row={row} />
                    </div>
                    <div className="flex items-center gap-1.5 pl-3.5 text-xs text-muted-foreground tabular-nums">
                      {formatBytes(row.previousBytes ?? 0)} → {formatBytes(row.bytes)}
                      <span aria-hidden>·</span>
                      {verify.isLoading && row.value !== "" ? (
                        <span className="inline-flex items-center gap-1">
                          <Spinner className="size-3" /> checking
                        </span>
                      ) : checked === undefined ? (
                        <span>not checked</span>
                      ) : (
                        <span title={`bytes_over_time, ${hourNote}`} className={cn(checked !== null && checked < 0 && "text-foreground")}>
                          {checked === null ? "new in the last hour" : `${formatGrowth(checked)} measured`}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              Index estimates; “measured” re-checks each with bytes_over_time over the {hourNote}.
              {verify.error ? ` The check failed: ${verify.error.message}` : ""}
            </p>
          </>
        )}
      </FrameWell>
    </Frame>
  )
}

function Volume({ snapshot }: { snapshot: LogsSnapshot }) {
  const [by, setBy] = React.useState(snapshot.groupLabel)
  const [range, setRange] = React.useState<LogsRange>(snapshot.range)
  const breakdown = useVolumeBreakdown(by, range)
  const { price, cost } = useBytesCost()

  const labelOptions = React.useMemo(() => {
    const names = new Set([snapshot.groupLabel, ...snapshot.labels.map((label) => label.label)])
    const byName = new Map(snapshot.labels.map((label) => [label.label, label]))
    return Array.from(names).map((name) => {
      const stat = byName.get(name)
      return { value: name, detail: stat ? `${formatNumber(stat.distinctValues)} values` : undefined }
    })
  }, [snapshot])

  const data = breakdown.data
  const rows = React.useMemo(() => (data ? compareVolumes(data.current, data.previous) : []), [data])
  const totals = React.useMemo(() => (data ? volumeTotals(data.current, data.previous) : null), [data])
  const series = useVolumeSeries(by, range)
  const colors = React.useMemo(() => new Map((series.data?.keys ?? []).map((key, index) => [key, SERIES_COLORS[index]])), [series.data])

  const daily = totals ? perDay(totals.bytes, range) : 0
  const dayCost = cost(daily)
  const streams = data ? streamChange(data.streams.now, data.streams.before) : null
  const growerCount = rows.filter((row) => row.grower).length

  return (
    <Page>
      <PageHeader
        title="Volume"
        status={
          totals ? (
            <>
              <HardDrivesIcon className="size-4" />
              <SwapText value={`${formatBytes(daily)}/day`} />
            </>
          ) : undefined
        }
        description={
          <>
            <Term id="logVolume">Bytes ingested</Term> by {by} over the last {LOGS_RANGE_LABEL[range]}, against the {LOGS_RANGE_LABEL[range]} before. Volume is what
            Grafana Cloud bills; noisy lines cost the most.
          </>
        }
        actions={
          <>
            <Combobox aria-label="Break down by label" prefix="by" value={by} onValueChange={setBy} options={labelOptions} placeholder="Search labels…" mono />
            <SegmentedControl aria-label="Range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />
            <Button variant="outline" onClick={() => void breakdown.refetch()} disabled={breakdown.isFetching}>
              {breakdown.isFetching ? <Spinner data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
              Refresh
            </Button>
          </>
        }
      />

      {breakdown.error ? (
        <EmptyState
          framed
          icon={WarningIcon}
          title="Couldn't measure volume"
          description={
            isAuthError(breakdown.error)
              ? "Unauthorized: Loki rejected the request (HTTP 401). Enter your token and retry."
              : `${breakdown.error.message}. Volume needs Loki's index/volume API (Loki 2.9+ with volume_enabled).`
          }
        >
          <Button variant="outline" onClick={() => void breakdown.refetch()}>
            Retry
          </Button>
        </EmptyState>
      ) : (
        <Stagger className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {!data || !totals ? (
              Array.from({ length: 4 }, (_, index) => (
                <Reveal key={index}>
                  <Skeleton className="h-[104px] rounded-[26px]" />
                </Reveal>
              ))
            ) : (
              <>
                <Reveal>
                  <StatFrame
                    label="Ingest per day"
                    value={<AnimatedNumber value={daily} format={formatBytes} />}
                    hint={
                      <span className="inline-flex items-center gap-1">
                        {formatBytes(totals.bytes)} in the last {range}
                        <InfoTip label="How volume is measured">{ESTIMATE_NOTE}</InfoTip>
                      </span>
                    }
                  />
                </Reveal>
                <Reveal>
                  <StatFrame
                    label="Cost per day"
                    value={dayCost === null ? "—" : <AnimatedNumber value={dayCost} format={formatCost} />}
                    hint={
                      price === undefined ? (
                        <Link to={paths.settings} className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                          Set a price per GB
                        </Link>
                      ) : (
                        `≈ ${formatCost(toGB(daily) * price * 30)}/mo at ${formatCost(price)}/GB`
                      )
                    }
                  />
                </Reveal>
                <Reveal>
                  <StatFrame
                    label={`vs previous ${range}`}
                    value={
                      totals.growth === null ? (
                        "—"
                      ) : (
                        <span className={cn(totals.growth >= 5 && "text-brand-ink")}>
                          <SwapText value={formatGrowth(totals.growth)} />
                        </span>
                      )
                    }
                    hint={
                      totals.delta === null
                        ? "No data in the previous period"
                        : `${formatBytesDelta(perDay(totals.delta, range))}/day · ${growerCount} grower${growerCount === 1 ? "" : "s"}`
                    }
                  />
                </Reveal>
                <Reveal>
                  <StatFrame
                    label="Streams"
                    value={<AnimatedNumber value={data.streams.now} />}
                    hint={
                      streams?.delta == null
                        ? `seen in the last ${range}`
                        : streams.delta > 0
                          ? `${formatNumber(streams.delta)} more than the previous ${range} (${formatGrowth(streams.growth)})`
                          : streams.delta < 0
                            ? `${formatNumber(-streams.delta)} fewer than the previous ${range}`
                            : `same as the previous ${range}`
                    }
                  />
                </Reveal>
              </>
            )}
          </div>

          <Reveal>
            <VolumeChart by={by} range={range} />
          </Reveal>

          <div className="grid gap-4 xl:grid-cols-3">
            <Reveal className="xl:col-span-2">
              <Frame className={cn("h-full", SERIES_COLOR_VARS)}>
                <FrameHeader
                  icon={HardDrivesIcon}
                  title={`By ${by}`}
                  meta={data ? `${formatNumber(data.current.length)} value${data.current.length === 1 ? "" : "s"}` : undefined}
                />
                <FrameWell className="px-2 py-1">
                  {!data ? (
                    <div className="flex flex-col gap-2 p-2">
                      {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-8 rounded-lg" />
                      ))}
                    </div>
                  ) : rows.length ? (
                    <VolumeTable key={`${by}-${range}`} rows={rows} by={by} groupLabel={snapshot.groupLabel} range={range} colors={colors} />
                  ) : (
                    <EmptyState compact icon={HardDrivesIcon} title="No volume" description={`No streams with ${by} in the last ${LOGS_RANGE_LABEL[range]}.`} />
                  )}
                </FrameWell>
              </Frame>
            </Reveal>
            <Reveal>{data ? <GrowersFrame rows={rows} by={by} range={range} hasPrevious={data.previous !== null} /> : <Skeleton className="h-64 rounded-[26px]" />}</Reveal>
          </div>
        </Stagger>
      )}
    </Page>
  )
}

export function LogVolumePage() {
  return <RequireLogsSnapshot>{(snapshot) => <Volume key={snapshot.capturedAt} snapshot={snapshot} />}</RequireLogsSnapshot>
}
