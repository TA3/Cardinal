import * as React from "react"
import { CaretDownIcon, CaretRightIcon, FingerprintIcon, SquaresFourIcon } from "@phosphor-icons/react"

import { LogRuleToggle } from "@/components/log-rule-toggle"
import { ShareBar } from "@/components/share-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/info-tip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { perDay, useGroupStreams, useLabelVolume } from "@/features/logs/streams-queries"
import { useLogqlUsage } from "@/features/usage/logql-scan"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { adviseLogLabel, labelStatsFromStreams, type GroupLabelStat, type LabelAdvice } from "@/lib/core/logs/label-advice"
import { partitionLogUsage, type LogQueryRef } from "@/lib/core/logs/logql-usage"
import type { LabelMatcher, LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { cn } from "@/lib/utils"

// The labels of one stream group: distinct values, streams saved by dropping
// each, the ID check, dashboard use, and the actions (move to structured
// metadata, drop), with top values and their volume on expand.

export function AdviceBadge({ advice }: { advice: LabelAdvice }) {
  const tone =
    advice.strength === "strong"
      ? "border-brand/40 bg-brand/5 text-brand-ink"
      : advice.strength === "suggested"
        ? "border-brand/25 text-brand-ink"
        : "text-muted-foreground"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("shrink-0 cursor-help", tone)} tabIndex={0}>
          {advice.title}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{advice.reason}</TooltipContent>
    </Tooltip>
  )
}

export function IdLikeBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0 border-brand/40 text-brand-ink" tabIndex={0}>
          <FingerprintIcon data-icon="inline-start" />
          ID-like
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        Most values look like IDs (UUIDs, hashes, numbers, IPs). Labels like this grow without bound: each new value is a new stream.
      </TooltipContent>
    </Tooltip>
  )
}

/** "Used in 3 panels", from the LogQL dashboard scan; nothing without a scan or use. */
export function DashboardUseBadge({ refs }: { refs: LogQueryRef[] }) {
  if (!refs.length) return null
  const dashboards = Array.from(new Set(refs.map((ref) => ref.where)))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0" tabIndex={0}>
          <SquaresFourIcon data-icon="inline-start" />
          {refs.length} panel{refs.length === 1 ? "" : "s"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        Used by {refs.map((ref) => ref.name).slice(0, 4).join(", ")}
        {refs.length > 4 ? ", …" : ""} in {dashboards.slice(0, 3).join(", ")}
        {dashboards.length > 3 ? ", …" : ""}.
      </TooltipContent>
    </Tooltip>
  )
}

/** Top values of a label with their volume, as thin bars. */
export function ValueVolumes({
  snapshot,
  matchers,
  label,
  streamsByValue,
}: {
  snapshot: LogsSnapshot
  matchers: LabelMatcher[]
  label: string
  streamsByValue?: Map<string, number>
}) {
  const { data, isPending, error } = useLabelVolume(snapshot, matchers, label, true, 25)
  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Spinner />
        Reading volume per value…
      </div>
    )
  }
  if (error) return <p className="py-2 text-xs text-destructive">{authErrorText(error, "logs")}</p>
  if (!data.length) return <p className="py-2 text-xs text-muted-foreground">No volume per value for {label}.</p>
  const total = data.reduce((sum, row) => sum + row.bytes, 0)
  return (
    <div className="grid gap-x-6 gap-y-1 py-2 sm:grid-cols-2">
      {data.map((row) => {
        const streams = streamsByValue?.get(row.value)
        return (
          <div key={row.value} className="flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-0.5 text-xs">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate font-mono" title={row.value}>
                {row.value}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatBytes(perDay(row.bytes, snapshot))}/day{streams !== undefined ? ` · ${formatNumber(streams)} str.` : ""}
              </span>
            </div>
            <ShareBar percent={total > 0 ? (row.bytes / total) * 100 : 0} showValue={false} className="min-w-0" />
          </div>
        )
      })}
    </div>
  )
}

function StreamsSavedCell({ stat, listed, known, approximate }: { stat: GroupLabelStat; listed: number; known: number; approximate: boolean }) {
  // A capped listing is scaled to the group's stream count.
  const after = approximate && listed > 0 ? Math.max(1, Math.round((known * stat.streamsIfDropped) / listed)) : stat.streamsIfDropped
  const before = approximate ? known : listed
  const saved = Math.max(0, before - after)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums" tabIndex={0}>
          {saved ? `${approximate ? "≈ " : ""}−${formatNumber(saved)}` : "0"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {saved
          ? `Without ${stat.label}, ${formatNumber(before)} streams merge into ${approximate ? "about " : ""}${formatNumber(after)}. Ingested bytes stay the same.`
          : `Every stream stays distinct without ${stat.label}: dropping it saves no streams, only index entries.`}
      </TooltipContent>
    </Tooltip>
  )
}

function LabelRow({
  stat,
  index,
  snapshot,
  matchers,
  selector,
  listed,
  known,
  approximate,
  dashboardRefs,
  open,
  onToggle,
}: {
  stat: GroupLabelStat
  index: number
  snapshot: LogsSnapshot
  matchers: LabelMatcher[]
  selector: StreamSelector
  listed: number
  known: number
  approximate: boolean
  dashboardRefs: LogQueryRef[] | null
  open: boolean
  onToggle: () => void
}) {
  const advice = adviseLogLabel({ label: stat.label, distinctValues: stat.distinctValues, idLike: stat.idLike, streams: stat.streams })
  const streamsByValue = React.useMemo(() => new Map(stat.values.map((item) => [item.value, item.streams])), [stat.values])
  const uses = React.useMemo(
    () => (dashboardRefs ? partitionLogUsage({ kind: "drop_label", selector, label: stat.label }, dashboardRefs).reads : []),
    [dashboardRefs, selector, stat.label]
  )
  const unique = stat.streams >= 2 && stat.distinctValues === stat.streams
  return (
    <>
      <TableRow
        className="animate-blur-in cursor-pointer"
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        onClick={(event) => {
          if (!(event.target instanceof Element && event.target.closest("button,a,[role=button]"))) onToggle()
        }}
      >
        <TableCell className="w-8">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} top values of ${stat.label}`}
            onClick={onToggle}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {open ? <CaretDownIcon /> : <CaretRightIcon />}
          </button>
        </TableCell>
        <TableCell className="max-w-0 min-w-16 sm:min-w-36">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs" title={stat.label}>
              {stat.label}
            </span>
            <span className="hidden items-center gap-1.5 sm:flex">
              {unique ? (
                <Badge variant="destructive" className="shrink-0">
                  one per stream
                </Badge>
              ) : null}
              {stat.idLike ? <IdLikeBadge /> : null}
              <DashboardUseBadge refs={uses} />
            </span>
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatNumber(stat.distinctValues)}</TableCell>
        <TableCell className="text-right">
          <StreamsSavedCell stat={stat} listed={listed} known={known} approximate={approximate} />
        </TableCell>
        <TableCell className="hidden lg:table-cell">
          <AdviceBadge advice={advice} />
        </TableCell>
        <TableCell className="text-right">
          <span className="inline-flex items-center justify-end gap-1">
            <LogRuleToggle kind="label_to_metadata" selector={selector} label={stat.label} size="responsive" reveal />
            <LogRuleToggle kind="drop_label" selector={selector} label={stat.label} size="icon" reveal className="hidden sm:inline-flex" />
          </span>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={5} className="whitespace-normal">
            <p className="pt-1 text-xs text-muted-foreground lg:hidden">{advice.reason}</p>
            <ValueVolumes snapshot={snapshot} matchers={[...matchers, { label: stat.label, op: "=~", value: ".+" }]} label={stat.label} streamsByValue={streamsByValue} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

export function GroupLabelsCard({
  snapshot,
  by,
  group,
  knownStreams,
  expanded,
  onExpand,
}: {
  snapshot: LogsSnapshot
  by: string
  group: string
  knownStreams: number | undefined
  expanded: string | null
  onExpand: (label: string | null) => void
}) {
  const matchers = React.useMemo<LabelMatcher[]>(() => [{ label: by, op: "=", value: group }], [by, group])
  const selector = React.useMemo<StreamSelector>(() => ({ matchers }), [matchers])
  const { data, isPending, error } = useGroupStreams(snapshot, matchers, knownStreams)
  const usage = useLogqlUsage()
  const stats = React.useMemo(() => (data ? labelStatsFromStreams(data.series).filter((stat) => stat.label !== by) : []), [data, by])
  const listed = React.useMemo(() => (data ? new Set(data.series.map((stream) => JSON.stringify(Object.entries(stream).sort()))).size : 0), [data])
  const approximate = Boolean(data && (data.truncated || data.lastHourOnly) && knownStreams && knownStreams > listed)
  const known = knownStreams ?? listed

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          Labels
          <InfoTip label="About this card">
            Each distinct label set is a stream. Labels with a value per stream multiply them: move those to structured metadata, or drop labels
            nothing queries. Expand a label for its top values and volume.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {data?.lastHourOnly ? (
          <p className="text-xs text-muted-foreground">
            This group has more than {formatNumber(5000)} streams, so labels are read from its last hour; stream savings are scaled estimates.
          </p>
        ) : data?.truncated ? (
          <p className="text-xs text-muted-foreground">Read from the first {formatNumber(data.series.length)} streams; savings are scaled estimates.</p>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't list the streams</AlertTitle>
            <AlertDescription>{authErrorText(error, "logs")}</AlertDescription>
          </Alert>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-8" />
            ))}
          </div>
        ) : stats.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No other labels on these streams in the range.</p>
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
                        <span className="sm:hidden">−streams</span>
                        <span className="hidden sm:inline">−streams if dropped</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      Distinct label sets left once the label is gone, from the group's stream listing. Moving the label to structured metadata
                      saves the same streams.
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead className="hidden lg:table-cell">Advice</TableHead>
                <TableHead className="w-12 text-right sm:w-44">
                  <span className="sr-only sm:not-sr-only">Rule</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((stat, index) => (
                <LabelRow
                  key={stat.label}
                  stat={stat}
                  index={index}
                  snapshot={snapshot}
                  matchers={matchers}
                  selector={selector}
                  listed={listed}
                  known={known}
                  approximate={approximate}
                  dashboardRefs={usage.index?.queries ?? null}
                  open={expanded === stat.label}
                  onToggle={() => onExpand(expanded === stat.label ? null : stat.label)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

/** Group label stats, shared with the volume card's label picker (same query). */
export function useGroupLabelStats(snapshot: LogsSnapshot, by: string, group: string, knownStreams: number | undefined) {
  const matchers = React.useMemo<LabelMatcher[]>(() => [{ label: by, op: "=", value: group }], [by, group])
  const { data } = useGroupStreams(snapshot, matchers, knownStreams)
  return React.useMemo(() => (data ? labelStatsFromStreams(data.series).filter((stat) => stat.label !== by) : null), [data, by])
}
