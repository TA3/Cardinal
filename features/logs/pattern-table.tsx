import * as React from "react"
import { ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react"
import { motion } from "motion/react"
import { Link } from "react-router"

import { CostText, useBytesCost } from "@/components/cost-text"
import { InfoTip } from "@/components/info-tip"
import { LogRuleToggle } from "@/components/log-rule-toggle"
import { Expand, FadeIn } from "@/components/motion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { serviceMatchers, usePatternByteShare, usePatternExamples, type PatternRange, type ServicePatterns } from "@/features/logs/patterns-data"
import { groupLink } from "@/features/logs/streams-shared"
import { Term } from "@/features/rules/term"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes } from "@/lib/core/bytes"
import {
  patternCoverage,
  patternLineFilter,
  patternPreview,
  patternSavings,
  patternSegments,
  patternToRegex,
  rankPatterns,
  sampleAxis,
  sparklineValues,
  type PatternRow,
} from "@/lib/core/logs/patterns"
import { groupNoun } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { perDay } from "@/lib/core/logs/volume"
import { cn } from "@/lib/utils"

// The one patterns table, used by the Patterns page and the stream group page:
// pattern text with its placeholders, lines, share, estimated bytes, a trend,
// and the same Drop lines / Sample / Protect toggles (LogRuleToggle, so the
// same usage gate) in both places. A row expands to recent lines and what
// cutting it saves.

export interface PatternTableRow extends PatternRow {
  service: string
}

const SHOWN = 30

/** Rows for one service's patterns, with bytes per day from the snapshot when it has the service. */
export function patternTableRows(snapshot: LogsSnapshot, groupLabel: string, service: string, data: ServicePatterns | undefined) {
  if (!data?.patterns) return { rows: [] as PatternTableRow[], coverage: null, bytesPerDay: null }
  // The snapshot's day-long rate reads less high than index/stats over a few hours; prefer it.
  const group = groupLabel === snapshot.groupLabel ? snapshot.groups.find((item) => item.value === service) : undefined
  const bytesPerDay = group ? perDay(group.bytes, snapshot.range) : data.bytesPerDay
  const rows = rankPatterns(data.patterns, { lines: data.lines, bytesPerDay }).map((row) => ({ ...row, service }))
  return { rows, coverage: patternCoverage(data.patterns, data.lines), bytesPerDay }
}

export function PatternText({ pattern, className }: { pattern: string; className?: string }) {
  const segments = patternSegments(pattern.replace(/\s+$/, ""))
  return (
    <code className={cn("font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap", className)}>
      {segments.map((segment, index) =>
        segment.placeholder ? (
          <span key={index} title="Varies between lines" className="mx-px inline-block rounded-[5px] bg-brand/12 px-0.5 whitespace-nowrap text-brand-ink">
            {segment.text}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </code>
  )
}

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const width = 72
  const height = 20
  if (values.length < 2) return <span className="text-xs text-muted-foreground">—</span>
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 1 - (value / max) * (height - 2)).toFixed(1)}`).join(" ")
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)}>
      <polyline points={points} fill="none" stroke="var(--brand)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Badge colours for a log level; null for no level. */
export function levelTone(level: string | undefined) {
  if (!level || level === "unknown") return null
  if (/err|crit|fatal|panic/i.test(level)) return "border-destructive/30 text-destructive"
  if (/warn/i.test(level)) return "border-amber-500/30 text-amber-700 dark:text-amber-400"
  return "text-muted-foreground"
}

function useRowRule(row: PatternTableRow, groupLabel: string) {
  return React.useMemo(() => {
    const line = patternLineFilter(row.pattern)
    const selector: StreamSelector = { matchers: serviceMatchers(groupLabel, row.service) }
    const share = `about ${(row.lineShare * 100).toFixed(1)}% of ${row.service}'s lines`
    return { line, selector, rationale: `Pattern "${patternPreview(row.pattern, 60)}" is ${share}.` }
  }, [row.pattern, row.service, row.lineShare, groupLabel])
}

/**
 * Drop lines, Sample and Protect for a pattern: the same LogRuleToggle (and
 * usage gate) as every other log rule control. Patterns that are nearly all
 * placeholders get no regex, so no actions.
 */
export function PatternActions({ row, groupLabel, size = "icon", reveal = false }: { row: PatternTableRow; groupLabel: string; size?: "icon" | "default"; reveal?: boolean }) {
  const { line, selector, rationale } = useRowRule(row, groupLabel)
  if (!line) return <span className="text-xs text-muted-foreground">too broad</span>
  return (
    <div className="flex items-center justify-end gap-1">
      <LogRuleToggle kind="drop_lines" selector={selector} line={line} rationale={rationale} size={size} reveal={reveal} />
      <LogRuleToggle kind="sample" selector={selector} line={line} rationale={rationale} size={size} reveal={reveal} />
      <LogRuleToggle kind="keep" selector={selector} line={line} size={size} reveal={reveal} />
    </div>
  )
}

function PatternDetail({ row, groupLabel, range, showOpen }: { row: PatternTableRow; groupLabel: string; range: PatternRange; showOpen: boolean }) {
  const info = React.useMemo(() => patternToRegex(row.pattern), [row.pattern])
  const regex = info.broad ? null : info.regex
  const examples = usePatternExamples(groupLabel, row.service, regex, range, true)
  const measured = usePatternByteShare(groupLabel, row.service, regex, true)
  const { price } = useBytesCost()

  const share = measured.data?.share ?? row.lineShare
  const bytesPerDay = row.bytesPerDay === null ? null : row.bytesPerDay * (measured.data?.share != null && row.lineShare > 0 ? measured.data.share / row.lineShare : 1)
  const dropSaves = bytesPerDay === null ? null : patternSavings(bytesPerDay, 0)
  const sampleSaves = bytesPerDay === null ? null : patternSavings(bytesPerDay, 0.1)

  return (
    <div className="flex flex-col gap-3 py-2 pr-1 pl-7">
      <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="text-xs text-muted-foreground">Recent lines like this</div>
          {!regex ? (
            <p className="text-sm text-muted-foreground">This pattern is almost all placeholders, so its lines can't be told apart from others.</p>
          ) : examples.isPending ? (
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-5 rounded-md" />
              ))}
            </div>
          ) : examples.error ? (
            <p className="text-sm text-muted-foreground">{authErrorText(examples.error, "logs")}</p>
          ) : examples.data?.length ? (
            <FadeIn className="flex flex-col gap-1">
              {examples.data.map((line, index) => (
                <div key={`${line.t}-${index}`} className="flex min-w-0 gap-2 rounded-lg bg-background/60 px-2 py-1">
                  <span className="shrink-0 font-mono text-[11px] leading-5 text-muted-foreground tabular-nums">
                    {new Date(line.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="min-w-0 truncate font-mono text-xs leading-5" title={line.line}>
                    {line.line}
                  </span>
                </div>
              ))}
            </FadeIn>
          ) : (
            <p className="text-sm text-muted-foreground">No lines matched in the last {range}. The regex may be stricter than the pattern (for example across line breaks).</p>
          )}
          {regex ? (
            <div className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Line regex</span>
              <code className="min-w-0 truncate font-mono text-[11px] text-foreground/80" title={regex}>
                {regex}
              </code>
              {info.truncated ? <span className="shrink-0">(prefix: pattern too long)</span> : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="text-xs text-muted-foreground">If you cut it</div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Share of lines</span>
            <span className="tabular-nums">{(row.lineShare * 100).toFixed(1)}%</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              Share of bytes
              <InfoTip label="How the byte share is measured">
                bytes_over_time of {row.service} with and without the pattern's line filter, over the last 15 minutes. Without it, the line share stands in.
              </InfoTip>
            </span>
            <span className="tabular-nums">
              {measured.isLoading ? <Spinner className="size-3" /> : measured.data?.share != null ? `${(share * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Drop saves</span>
            <span className="text-brand-ink tabular-nums" title={BYTES_NOTE}>
              {dropSaves === null ? "—" : `~−${formatBytes(dropSaves)}/day`}
            </span>
          </div>
          {price !== undefined && dropSaves ? <CostText bytes={dropSaves} per="day" className="-mt-1 self-end" /> : null}
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Sample to 10% saves</span>
            <span className="tabular-nums" title={BYTES_NOTE}>
              {sampleSaves === null ? "—" : `~−${formatBytes(sampleSaves)}/day`}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PatternActions row={row} groupLabel={groupLabel} size="default" />
        {showOpen ? (
          <Button size="sm" variant="ghost" asChild>
            <Link to={groupLink(row.service, groupLabel)}>
              <ArrowSquareOutIcon data-icon="inline-start" />
              Open {row.service}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function subscribeResize(listener: () => void) {
  globalThis.addEventListener("resize", listener)
  return () => globalThis.removeEventListener("resize", listener)
}

/** Visible table columns at this width, so full-width rows span exactly those. */
function useVisibleColumns(showService: boolean) {
  const wide = React.useSyncExternalStore(subscribeResize, () =>
    globalThis.matchMedia("(min-width: 64rem)").matches ? 2 : globalThis.matchMedia("(min-width: 40rem)").matches ? 1 : 0
  )
  // Pattern, Share, Actions always; Lines and Est./day from sm; Trend (and Service) from lg.
  return 3 + (wide >= 1 ? 2 : 0) + (wide >= 2 ? 1 + (showService ? 1 : 0) : 0)
}

function PatternRowView({
  row,
  index,
  expanded,
  onToggle,
  axis,
  showService,
  groupLabel,
}: {
  row: PatternTableRow
  index: number
  expanded: boolean
  onToggle: () => void
  axis: number[]
  showService: boolean
  groupLabel: string
}) {
  const tone = levelTone(row.level)
  return (
    <TableRow
      className="animate-blur-in cursor-pointer align-top"
      style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
      onClick={(event) => {
        if (!(event.target instanceof Element && event.target.closest("a,button,[role=dialog]"))) onToggle()
      }}
    >
      <TableCell className="min-w-0 whitespace-normal">
        <div className="flex min-w-0 items-start gap-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} lines like this`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ type: "spring", bounce: 0.2, duration: 0.35 }} className="flex">
              <CaretRightIcon className="size-3.5" />
            </motion.span>
          </button>
          <div className="flex min-w-0 flex-col gap-1">
            <PatternText pattern={row.pattern} className={cn(!expanded && "line-clamp-2")} />
            <div className="flex flex-wrap items-center gap-1.5">
              {tone ? (
                <Badge variant="outline" className={cn("h-4 px-1.5 text-[10px] uppercase", tone)}>
                  {row.level}
                </Badge>
              ) : null}
              {showService ? <span className="truncate text-xs text-muted-foreground lg:hidden">{row.service}</span> : null}
            </div>
          </div>
        </div>
      </TableCell>
      {showService ? (
        <TableCell className="hidden truncate text-sm lg:table-cell" title={row.service}>
          {row.service}
        </TableCell>
      ) : null}
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatNumber(row.count)}</TableCell>
      <TableCell className="text-right tabular-nums">{row.lineShare >= 0.001 ? `${(row.lineShare * 100).toFixed(row.lineShare >= 0.1 ? 0 : 1)}%` : "<0.1%"}</TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">{row.bytesPerDay === null ? "—" : formatBytes(row.bytesPerDay)}</TableCell>
      <TableCell className="hidden lg:table-cell">
        <Sparkline values={sparklineValues(row.samples, axis)} />
      </TableCell>
      <TableCell className="text-right">
        <PatternActions row={row} groupLabel={groupLabel} reveal />
      </TableCell>
    </TableRow>
  )
}

/** Patterns ranked by lines; `showService` adds a service column (the Patterns page's "Top 5"). */
export function PatternsTable({
  rows,
  groupLabel,
  range,
  showService,
  showOpen = true,
  initial = SHOWN,
}: {
  rows: PatternTableRow[]
  groupLabel: string
  range: PatternRange
  showService: boolean
  /** An "Open <service>" link in the expanded row (not on the service's own page). */
  showOpen?: boolean
  /** Rows shown before "Show all". */
  initial?: number
}) {
  const columns = useVisibleColumns(showService)
  const [open, setOpen] = React.useState<string | null>(null)
  const [all, setAll] = React.useState(false)
  const shown = all ? rows : rows.slice(0, initial)
  // The newest bucket is still filling up; leave it out so every line doesn't end in a drop.
  const axis = React.useMemo(() => {
    const all = sampleAxis(rows)
    return all.length > 2 ? all.slice(0, -1) : all
  }, [rows])
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>
            <Term id="logPattern">Pattern</Term>
          </TableHead>
          {showService ? <TableHead className="hidden w-36 lg:table-cell">{groupNoun(groupLabel, false)}</TableHead> : null}
          <TableHead className="hidden w-20 text-right sm:table-cell">Lines</TableHead>
          <TableHead className="w-14 text-right">Share</TableHead>
          <TableHead className="hidden w-20 text-right sm:table-cell" title={`Estimated: share of lines × the service's bytes per day. ${BYTES_NOTE}`}>
            Est./day
          </TableHead>
          <TableHead className="hidden w-24 lg:table-cell">Trend</TableHead>
          <TableHead className="w-28">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((row, index) => {
          const key = JSON.stringify([row.service, row.pattern])
          const expanded = open === key
          return (
            <React.Fragment key={key}>
              <PatternRowView
                row={row}
                index={index}
                expanded={expanded}
                onToggle={() => setOpen(expanded ? null : key)}
                axis={axis}
                showService={showService}
                groupLabel={groupLabel}
              />
              {expanded ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns} className="p-0 whitespace-normal">
                    <Expand open>
                      <PatternDetail row={row} groupLabel={groupLabel} range={range} showOpen={showOpen} />
                    </Expand>
                  </TableCell>
                </TableRow>
              ) : null}
            </React.Fragment>
          )
        })}
        {rows.length > initial ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns} className="text-center">
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
