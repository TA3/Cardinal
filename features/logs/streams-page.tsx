import * as React from "react"
import { ArrowDownIcon, MagnifyingGlassIcon, WavesIcon } from "@phosphor-icons/react"
import { Link, useNavigate, useSearchParams } from "react-router"

import { CostText, useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { findActiveLogRule, LogRuleToggle } from "@/components/log-rule-toggle"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { ShareBar } from "@/components/share-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { Term } from "@/features/rules/term"
import { fromControl, groupLink, LogsSnapshotLine, patchParams } from "@/features/logs/streams-shared"
import { perDay, useLogGroups, useStreamStats, type GroupRow } from "@/features/logs/streams-queries"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes } from "@/lib/core/bytes"
import { groupNoun, LOGS_RANGE_LABEL } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// The logs equivalent of Explore/Jobs: every group (service by default) by
// bytes ingested, with its streams, share and cost, and a drop toggle.

const PAGE_SIZE = 50
type Sort = "bytes" | "streams" | "name"

const groupSelector = (label: string, value: string): StreamSelector => ({ matchers: [{ label, op: "=", value }] })

/** Streams of a group outside the snapshot's top groups: measured when the row shows. */
function StreamsCell({ snapshot, label, row }: { snapshot: LogsSnapshot; label: string; row: GroupRow }) {
  const matchers = React.useMemo(() => [{ label, op: "=" as const, value: row.value }], [label, row.value])
  const stats = useStreamStats(snapshot, matchers, row.streams === undefined)
  if (row.streams !== undefined) return <>{formatNumber(row.streams)}</>
  if (stats.data) return <>{formatNumber(stats.data.streams)}</>
  if (stats.error) return <span className="text-xs text-muted-foreground" title={stats.error.message}>n/a</span>
  return <Spinner className="ml-auto size-3.5" />
}

function StreamsTable({ snapshot, label, rows, resetKey }: { snapshot: LogsSnapshot; label: string; rows: GroupRow[]; resetKey: string }) {
  const navigate = useNavigate()
  const { price } = useBytesCost()
  const [paging, setPaging] = React.useState({ key: resetKey, limit: PAGE_SIZE })
  const limit = paging.key === resetKey ? paging.limit : PAGE_SIZE
  const visible = rows.slice(0, limit)
  const logRules = useAppStore((state) => state.logRules)
  const proposed = React.useMemo(
    () =>
      new Set(
        logRules
          .filter((rule) => rule.status === "proposed" && rule.selector.matchers.length === 1 && rule.selector.matchers[0].label === label && rule.selector.matchers[0].op === "=")
          .map((rule) => rule.selector.matchers[0].value)
      ),
    [logRules, label]
  )

  const { rowProps } = useRowCursor({
    count: visible.length,
    resetKey,
    onOpen: (index) => {
      const row = visible[index]
      if (row) navigate(groupLink(row.value, label))
    },
    onToggle: (index) => {
      const row = visible[index]
      if (!row) return
      const { toggleLogRule } = useAppStore.getState()
      toggleLogRule({ kind: "drop_streams", selector: groupSelector(label, row.value), origin: "user" })
    },
  })

  return (
    <div className="flex flex-col gap-2">
      <Table containerClassName="overflow-x-clip">
        <TableHeader className="sticky top-[104px] z-10 bg-well shadow-[0_1px_0_var(--border)]">
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className="text-right">
              <Term id="logStream">Streams</Term>
            </TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center gap-1" title={BYTES_NOTE}>
                Per day
                <ArrowDownIcon />
              </span>
            </TableHead>
            <TableHead className="hidden w-44 sm:table-cell">Share of volume</TableHead>
            {price !== undefined ? <TableHead className="hidden text-right md:table-cell">Cost</TableHead> : null}
            <TableHead className="w-12 text-right sm:w-28">
              <span className="sr-only sm:not-sr-only">Rule</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row, index) => {
            const selector = groupSelector(label, row.value)
            const dropped = Boolean(findActiveLogRule(logRules, { kind: "drop_streams", selector }))
            const day = perDay(row.bytes, snapshot)
            return (
              <TableRow
                key={row.value}
                {...rowProps(index)}
                className={cn("animate-blur-in cursor-pointer data-[state=selected]:bg-destructive/[0.04]", CURSOR_ROW_CLASS)}
                style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
                data-state={dropped ? "selected" : undefined}
                onClick={(event) => {
                  if (!fromControl(event)) navigate(groupLink(row.value, label))
                }}
              >
                <TableCell className="max-w-0 min-w-44">
                  <div className="flex items-center gap-2">
                    <Link
                      to={groupLink(row.value, label)}
                      title={row.value}
                      className="truncate rounded-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {row.value}
                    </Link>
                    {proposed.has(row.value) ? (
                      <Badge variant="secondary" className="shrink-0">
                        Proposed
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <StreamsCell snapshot={snapshot} label={label} row={row} />
                </TableCell>
                <TableCell className="text-right tabular-nums" title={`${formatBytes(row.bytes)} in the last ${LOGS_RANGE_LABEL[snapshot.range]}`}>
                  {formatBytes(day)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <ShareBar percent={row.share} />
                </TableCell>
                {price !== undefined ? (
                  <TableCell className="hidden text-right md:table-cell">
                    <CostText bytes={day} per="day" />
                  </TableCell>
                ) : null}
                <TableCell className="text-right">
                  <LogRuleToggle kind="drop_streams" selector={selector} size="responsive" reveal hint={`−${formatBytes(day)}/day`} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {rows.length > limit ? (
        <Button variant="ghost" size="sm" className="self-center" onClick={() => setPaging({ key: resetKey, limit: limit + PAGE_SIZE })}>
          Show more ({formatNumber(rows.length - limit)} remaining)
        </Button>
      ) : null}
    </div>
  )
}

function StreamsList({ snapshot }: { snapshot: LogsSnapshot }) {
  const [params, setParams] = useSearchParams()
  const query = params.get("q") ?? ""
  const deferredQuery = React.useDeferredValue(query)
  const by = params.get("by") || snapshot.groupLabel
  const own = by === snapshot.groupLabel
  const sortParam = params.get("sort")
  const sort: Sort = sortParam === "name" ? "name" : sortParam === "streams" && own ? "streams" : "bytes"
  const update = (patch: Record<string, string | null>) => setParams((current) => patchParams(current, patch), { replace: true })

  // The snapshot counts streams for its top groups; the rest (and other labels) come from index/volume.
  const needsFetch = !own || Boolean(snapshot.groupsTruncated)
  const fetched = useLogGroups(snapshot, by, needsFetch)
  const all = React.useMemo<GroupRow[] | null>(() => {
    if (!own) return fetched.data?.rows ?? null
    const known = new Map(snapshot.groups.map((group) => [group.value, group]))
    if (!snapshot.groupsTruncated || !fetched.data) return snapshot.groups.map((group) => ({ ...group }))
    return fetched.data.rows.map((row) => ({ ...row, streams: known.get(row.value)?.streams }))
  }, [own, fetched.data, snapshot])

  const rows = React.useMemo(() => {
    if (!all) return []
    const needle = deferredQuery.trim().toLowerCase()
    const filtered = needle ? all.filter((row) => row.value.toLowerCase().includes(needle)) : all
    const sorted = [...filtered]
    if (sort === "name") sorted.sort((a, b) => a.value.localeCompare(b.value))
    else if (sort === "streams") sorted.sort((a, b) => (b.streams ?? -1) - (a.streams ?? -1) || b.bytes - a.bytes)
    else sorted.sort((a, b) => b.bytes - a.bytes)
    return sorted
  }, [all, deferredQuery, sort])

  const labelOptions = React.useMemo(() => {
    const names = new Set([snapshot.groupLabel, ...snapshot.labels.map((label) => label.label)])
    const values = new Map(snapshot.labels.map((label) => [label.label, label.distinctValues]))
    return Array.from(names).map((name) => ({ name, values: values.get(name) }))
  }, [snapshot])
  const noun = groupNoun(by)
  const count = all?.length ?? 0
  const sortOptions = [
    { value: "bytes" as const, label: "Volume" },
    ...(own ? [{ value: "streams" as const, label: "Streams" }] : []),
    { value: "name" as const, label: "Name" },
  ]

  return (
    <Page>
      <PageHeader
        title="Streams"
        description={
          <span className="flex flex-col gap-1">
            <span>
              {all ? `${formatNumber(count)} ${groupNoun(by)}` : `Grouping by ${by}`}, by <Term id="logVolume">volume</Term> ingested over the last{" "}
              {LOGS_RANGE_LABEL[snapshot.range]}. Each row is the <Term id="logStream">streams</Term> sharing one {by} value; open one to see which
              labels multiply them.
            </span>
            <LogsSnapshotLine snapshot={snapshot} />
          </span>
        }
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <InputGroup className="sm:max-w-sm">
          <InputGroupInput placeholder={`Filter ${noun}…`} aria-label={`Filter ${noun}`} value={query} onChange={(event) => update({ q: event.target.value })} />
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <InputGroupText>{formatNumber(rows.length)}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <div className="flex items-center gap-2">
          <Select value={by} onValueChange={(value) => update({ by: value === snapshot.groupLabel ? null : value, sort: null })}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-56 sm:flex-none" aria-label="Group streams by">
              <span className="text-muted-foreground">By</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Group streams by</SelectLabel>
                {labelOptions.map((option) => (
                  <SelectItem key={option.name} value={option.name}>
                    <span className="font-mono text-xs">{option.name}</span>
                    {option.values !== undefined ? <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{formatNumber(option.values)}</span> : null}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <SegmentedControl aria-label="Sort by" value={sort} onValueChange={(value) => update({ sort: value === "bytes" ? null : value })} options={sortOptions} className="shrink-0" />
        </div>
        {fetched.isFetching ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto">
            <Spinner className="size-3.5" />
            Reading volume by {by}…
          </span>
        ) : null}
      </div>
      {own && snapshot.groupsTruncated && !fetched.data && !fetched.isFetching ? (
        <p className="-mt-1 text-xs text-muted-foreground">
          Showing the top {snapshot.groups.length} of {formatNumber(snapshot.groupCount ?? 0)} {noun}.
        </p>
      ) : null}
      {fetched.data?.truncated ? <p className="-mt-1 text-xs text-muted-foreground">Showing the largest 1,000 values of {by}.</p> : null}
      <Card className="overflow-visible">
        <CardContent>
          {fetched.error && !own ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't read volume by {by}</AlertTitle>
              <AlertDescription>
                {authErrorText(fetched.error, "logs")}
              </AlertDescription>
            </Alert>
          ) : all === null ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-9" />
              ))}
            </div>
          ) : count === 0 ? (
            <EmptyState icon={WavesIcon} title={`No volume by ${by}`} description={`No stream carried ${by} in the last ${LOGS_RANGE_LABEL[snapshot.range]}. Try another label.`} />
          ) : rows.length === 0 ? (
            <EmptyState icon={MagnifyingGlassIcon} title={`No matching ${noun}`} description={`Nothing matches “${query}”.`} />
          ) : (
            <StreamsTable snapshot={snapshot} label={by} rows={rows} resetKey={JSON.stringify([deferredQuery, by, sort])} />
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

export function StreamsPage() {
  return <RequireLogsSnapshot>{(snapshot) => <StreamsList snapshot={snapshot} />}</RequireLogsSnapshot>
}
