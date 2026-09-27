import * as React from "react"
import { ArrowDownIcon, CaretRightIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"

import { jobPath, metricPath } from "@/app/paths"
import { DropToggle } from "@/components/drop-toggle"
import { ShareBar } from "@/components/share-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { toggleMetricDrop, type DropScope } from "@/features/explore/drop-scope"
import { formatNumber, histogramFamily } from "@/lib/cardinality/dashboard-helpers"
import { jobLabel } from "@/lib/core/jobs"
import { metricDropRule, selectionView, useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

export interface MetricRow {
  metric: string
  seriesCount: number
  percentageOfTotal: number
  topJob?: string
}

interface FamilyEntry {
  type: "family"
  base: string
  members: MetricRow[]
  seriesCount: number
  percentageOfTotal: number
  topJob?: string
  /** "histogram" when it has _bucket series, otherwise "summary". */
  flavour: "histogram" | "summary"
}

type TopEntry = { type: "metric"; row: MetricRow } | FamilyEntry
type VisibleEntry = { type: "metric"; row: MetricRow; child: boolean } | FamilyEntry

const PAGE_SIZE = 50

/**
 * Collapses `x_bucket` / `x_sum` / `x_count` (and a summary's bare `x`) into
 * one family entry when at least two members are present. Sorted by series.
 */
export function groupFamilies(rows: MetricRow[]): TopEntry[] {
  const byBase = new Map<string, MetricRow[]>()
  for (const row of rows) {
    const { base, part } = histogramFamily(row.metric)
    if (part) byBase.set(base, [...(byBase.get(base) ?? []), row])
  }
  const names = new Set(rows.map((row) => row.metric))
  const bare = new Map(rows.filter((row) => byBase.has(row.metric)).map((row) => [row.metric, row]))
  const families = new Map<string, FamilyEntry>()
  for (const [base, parts] of byBase) {
    const members = bare.has(base) ? [bare.get(base)!, ...parts] : parts
    if (members.length < 2) continue
    members.sort((a, b) => b.seriesCount - a.seriesCount)
    families.set(base, {
      type: "family",
      base,
      members,
      seriesCount: members.reduce((sum, member) => sum + member.seriesCount, 0),
      percentageOfTotal: members.reduce((sum, member) => sum + member.percentageOfTotal, 0),
      topJob: members[0].topJob,
      flavour: names.has(`${base}_bucket`) ? "histogram" : "summary",
    })
  }
  const entries: TopEntry[] = []
  for (const row of rows) {
    const { base, part } = histogramFamily(row.metric)
    const family = families.get(part ? base : row.metric)
    if (!family) entries.push({ type: "metric", row })
    // The family goes in once, at its largest member.
    else if (family.members[0] === row) entries.push(family)
  }
  return entries.sort((a, b) => (b.type === "family" ? b.seriesCount : b.row.seriesCount) - (a.type === "family" ? a.seriesCount : a.row.seriesCount))
}

/** Clicks on links and buttons inside a row keep their own behaviour. */
function fromControl(event: React.MouseEvent) {
  return event.target instanceof Element && event.target.closest("a,button,[role=button]") !== null
}

export function MetricsTable({
  rows,
  showJob = true,
  shareLabel = "Share",
  job,
  scope = "job",
  resetKey,
  stickyHeader = false,
  groupHistograms = false,
  keyboard = false,
}: {
  rows: MetricRow[]
  showJob?: boolean
  shareLabel?: string
  /** The job whose view this is; drops then default to that job. */
  job?: string
  scope?: DropScope
  /** Paging starts over when this changes (the filters), not when rows are recomputed. */
  resetKey: string
  /** Pins the header under the top bar; the surrounding card must not clip overflow. */
  stickyHeader?: boolean
  /** Collapse histogram and summary families into one expandable row. */
  groupHistograms?: boolean
  /** j / k / Enter / x row shortcuts; enable on one table per page. */
  keyboard?: boolean
}) {
  const navigate = useNavigate()
  const rules = useAppStore((state) => state.rules)
  const { selectedLabelsByMetric } = React.useMemo(() => selectionView(rules, job), [rules, job])
  const proposed = React.useMemo(
    () =>
      new Set(
        rules
          .filter((rule) => rule.status === "proposed" && (rule.selector.job === undefined || job === undefined || rule.selector.job === job))
          .map((rule) => rule.selector.metric)
      ),
    [rules, job]
  )
  // In the all-jobs view, metrics dropped for some jobs only.
  const scopedDrops = React.useMemo(() => {
    const counts = new Map<string, number>()
    if (job !== undefined) return counts
    for (const rule of rules) {
      if (rule.status === "active" && rule.kind === "drop_metric" && rule.selector.job !== undefined) {
        counts.set(rule.selector.metric, (counts.get(rule.selector.metric) ?? 0) + 1)
      }
    }
    return counts
  }, [rules, job])
  const [paging, setPaging] = React.useState({ key: resetKey, limit: PAGE_SIZE })
  const limit = paging.key === resetKey ? paging.limit : PAGE_SIZE
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())

  const entries = React.useMemo<TopEntry[]>(
    () => (groupHistograms ? groupFamilies(rows) : rows.map((row) => ({ type: "metric", row }))),
    [rows, groupHistograms]
  )
  const visible = React.useMemo(() => {
    const list: VisibleEntry[] = []
    for (const entry of entries.slice(0, limit)) {
      if (entry.type === "metric") list.push({ type: "metric", row: entry.row, child: false })
      else {
        list.push(entry)
        if (expanded.has(entry.base)) for (const member of entry.members) list.push({ type: "metric", row: member, child: true })
      }
    }
    return list
  }, [entries, limit, expanded])

  const toggleFamily = React.useCallback((base: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(base)) next.delete(base)
      else next.add(base)
      return next
    })
  }, [])

  const { rowProps } = useRowCursor({
    count: visible.length,
    resetKey: `${resetKey}|${groupHistograms}`,
    enabled: keyboard,
    onOpen: (index) => {
      const entry = visible[index]
      if (entry?.type === "family") toggleFamily(entry.base)
      else if (entry) navigate(metricPath(entry.row.metric))
    },
    onToggle: (index) => {
      const entry = visible[index]
      if (entry?.type === "metric") toggleMetricDrop(entry.row.metric, job, scope)
    },
  })

  const metricRow = (row: MetricRow, index: number, child: boolean) => {
    const dropRule = metricDropRule(rules, row.metric, job)
    const isDropped = Boolean(dropRule)
    const labelDrops = selectedLabelsByMetric[row.metric]?.length ?? 0
    const partial = scopedDrops.get(row.metric) ?? 0
    return (
      <TableRow
        key={row.metric}
        {...rowProps(index)}
        className={cn("animate-blur-in cursor-pointer data-[state=selected]:bg-destructive/[0.04]", CURSOR_ROW_CLASS, child && "bg-well/40")}
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        data-state={isDropped ? "selected" : undefined}
        onClick={(event) => {
          if (!fromControl(event)) navigate(metricPath(row.metric))
        }}
      >
        <TableCell className="max-w-0 min-w-48">
          <div className={cn("flex items-center gap-2", child && "pl-6")}>
            <Link
              to={metricPath(row.metric)}
              title={row.metric}
              className="truncate rounded-sm font-mono text-xs hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {row.metric}
            </Link>
            {labelDrops ? (
              <Badge variant="outline" className="shrink-0">
                −{labelDrops} label{labelDrops === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {partial && !isDropped ? (
              <Badge variant="outline" className="shrink-0">
                Dropped in {partial} job{partial === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {proposed.has(row.metric) ? (
              <Badge variant="secondary" className="shrink-0">
                Proposed
              </Badge>
            ) : null}
          </div>
        </TableCell>
        {showJob ? (
          <TableCell className="hidden max-w-40 truncate text-muted-foreground lg:table-cell">
            {row.topJob !== undefined ? (
              <Link
                to={jobPath(row.topJob)}
                title={jobLabel(row.topJob)}
                className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {jobLabel(row.topJob)}
              </Link>
            ) : null}
          </TableCell>
        ) : null}
        <TableCell className="text-right tabular-nums">{formatNumber(row.seriesCount)}</TableCell>
        <TableCell className="hidden sm:table-cell">
          <ShareBar percent={row.percentageOfTotal} />
        </TableCell>
        <TableCell className="text-right">
          <DropToggle metric={row.metric} job={job} scope={scope} size="responsive" reveal />
        </TableCell>
      </TableRow>
    )
  }

  const familyRow = (family: FamilyEntry, index: number) => {
    const open = expanded.has(family.base)
    const dropped = family.members.filter((member) => metricDropRule(rules, member.metric, job)).length
    return (
      <TableRow
        key={`family:${family.base}`}
        {...rowProps(index)}
        className={cn("animate-blur-in cursor-pointer", CURSOR_ROW_CLASS)}
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        onClick={(event) => {
          if (!fromControl(event)) toggleFamily(family.base)
        }}
      >
        <TableCell className="max-w-0 min-w-48">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${family.base} (${family.members.length} metrics)`}
              onClick={() => toggleFamily(family.base)}
              className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-well hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <CaretRightIcon className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
            </button>
            <span className="truncate font-mono text-xs" title={family.members.map((member) => member.metric).join(", ")}>
              {family.base}
            </span>
            <Badge variant="outline" className="shrink-0">
              {family.flavour} · {family.members.length}
            </Badge>
            {dropped ? (
              <Badge variant="outline" className="shrink-0 border-destructive/25 text-destructive">
                {dropped} dropped
              </Badge>
            ) : null}
          </div>
        </TableCell>
        {showJob ? (
          <TableCell className="hidden max-w-40 truncate text-muted-foreground lg:table-cell">
            {family.topJob !== undefined ? jobLabel(family.topJob) : null}
          </TableCell>
        ) : null}
        <TableCell className="text-right font-medium tabular-nums">{formatNumber(family.seriesCount)}</TableCell>
        <TableCell className="hidden sm:table-cell">
          <ShareBar percent={family.percentageOfTotal} />
        </TableCell>
        <TableCell>
          {/* Matches the height of rows with a Drop control. */}
          <span aria-hidden className="inline-block h-7" />
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Table containerClassName={stickyHeader ? "overflow-x-clip" : undefined}>
        <TableHeader className={stickyHeader ? "sticky top-[104px] z-10 bg-well shadow-[0_1px_0_var(--border)]" : undefined}>
          <TableRow>
            <TableHead>Metric</TableHead>
            {showJob ? <TableHead className="hidden lg:table-cell">Top job</TableHead> : null}
            <TableHead className="text-right">
              <span className="inline-flex items-center gap-1">
                Series
                <ArrowDownIcon />
              </span>
            </TableHead>
            <TableHead className="hidden w-44 sm:table-cell">{shareLabel}</TableHead>
            <TableHead className="w-12 text-right sm:w-28">
              <span className="sr-only sm:not-sr-only">Rule</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry, index) => (entry.type === "family" ? familyRow(entry, index) : metricRow(entry.row, index, entry.child)))}
        </TableBody>
      </Table>
      {entries.length > limit ? (
        <Button variant="ghost" size="sm" className="self-center" onClick={() => setPaging({ key: resetKey, limit: limit + PAGE_SIZE * 2 })}>
          Show more ({formatNumber(entries.length - limit)} remaining)
        </Button>
      ) : null}
    </div>
  )
}
