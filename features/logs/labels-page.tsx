import * as React from "react"
import { CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon, TagSimpleIcon } from "@phosphor-icons/react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LogRuleToggle } from "@/components/log-rule-toggle"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { Term } from "@/features/rules/term"
import { AdviceBadge, IdLikeBadge, ValueVolumes } from "@/features/logs/stream-detail-labels"
import { perDay, useStreamStats } from "@/features/logs/streams-queries"
import { fromControl, LogsSnapshotLine, patchParams } from "@/features/logs/streams-shared"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes } from "@/lib/core/bytes"
import { adviseLogLabel, guardedLogLabel } from "@/lib/core/logs/label-advice"
import { groupNoun, LOGS_RANGE_LABEL, MAX_LABEL_VALUES } from "@/lib/core/logs/snapshot"
import type { LabelMatcher, LogLabelStat, LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// Every stream label: how many values it has, how many streams and bytes carry
// it, whether its values look like IDs, and what to do about it. Actions apply
// to every stream, or to one service.

const PAGE_SIZE = 40
const ALL = "__all__"
type Sort = "values" | "name"
const SORT_OPTIONS = [
  { value: "values" as const, label: "Values" },
  { value: "name" as const, label: "Name" },
]

function LabelRow({
  stat,
  index,
  snapshot,
  scopeMatchers,
  scopeName,
  open,
  focused,
  rowProps,
  onToggle,
}: {
  stat: LogLabelStat
  index: number
  snapshot: LogsSnapshot
  scopeMatchers: LabelMatcher[]
  /** The chosen service, or null for all streams. */
  scopeName: string | null
  open: boolean
  focused: boolean
  rowProps: ReturnType<ReturnType<typeof useRowCursor>["rowProps"]>
  onToggle: () => void
}) {
  const touched = React.useMemo<LabelMatcher[]>(() => [...scopeMatchers, { label: stat.label, op: "=~", value: ".+" }], [scopeMatchers, stat.label])
  const stats = useStreamStats(snapshot, touched)
  const selector = React.useMemo<StreamSelector>(() => ({ matchers: scopeMatchers }), [scopeMatchers])
  const truncated = Boolean(snapshot.labelsTruncated && stat.distinctValues >= MAX_LABEL_VALUES)
  // Distinct values are counted over all streams, so "one value per stream" only compares at that scope.
  const advice = adviseLogLabel({ label: stat.label, distinctValues: stat.distinctValues, idLike: stat.idLike, truncated, streams: scopeName === null ? stats.data?.streams : undefined })
  const rowRef = React.useRef<HTMLTableRowElement | null>(null)
  React.useEffect(() => {
    if (focused) requestAnimationFrame(() => rowRef.current?.scrollIntoView({ block: "center" }))
  }, [focused])

  return (
    <>
      <TableRow
        {...rowProps}
        ref={(element) => {
          rowRef.current = element
          rowProps.ref(element)
        }}
        className={cn("animate-blur-in cursor-pointer", CURSOR_ROW_CLASS, focused && "bg-brand/[0.04]")}
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        onClick={(event) => {
          if (!fromControl(event)) onToggle()
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
        <TableCell className="max-w-0 min-w-36">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs" title={stat.label}>
              {stat.label}
            </span>
            {stat.idLike ? <IdLikeBadge /> : null}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatNumber(stat.distinctValues)}
          {truncated ? "+" : ""}
        </TableCell>
        <TableCell className="hidden text-right tabular-nums sm:table-cell">
          {stats.data ? formatNumber(stats.data.streams) : stats.error ? <span className="text-xs text-muted-foreground" title={authErrorText(stats.error, "logs")}>—</span> : <Spinner className="ml-auto size-3.5" />}
        </TableCell>
        <TableCell className="hidden text-right tabular-nums md:table-cell" title={stats.data ? `${formatBytes(stats.data.bytes)} in the last ${LOGS_RANGE_LABEL[snapshot.range]}` : undefined}>
          {stats.data ? `${formatBytes(perDay(stats.data.bytes, snapshot))}` : null}
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
          <TableCell colSpan={6} className="whitespace-normal">
            <p className="pt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{advice.title}.</span> {advice.reason}
            </p>
            <ValueVolumes snapshot={snapshot} matchers={scopeMatchers} label={stat.label} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function LabelsList({ snapshot }: { snapshot: LogsSnapshot }) {
  const [params, setParams] = useSearchParams()
  const focus = params.get("label")
  const query = params.get("q") ?? ""
  const deferredQuery = React.useDeferredValue(query)
  const sort: Sort = params.get("sort") === "name" ? "name" : "values"
  const scopeParam = params.get("scope")
  const scope = scopeParam !== null && snapshot.groups.some((group) => group.value === scopeParam) ? scopeParam : null
  const update = (patch: Record<string, string | null>) => setParams((current) => patchParams(current, patch), { replace: true })
  const [expanded, setExpanded] = React.useState<string | null>(focus)
  const [pagingState, setPagingState] = React.useState({ key: "", size: PAGE_SIZE })

  const scopeMatchers = React.useMemo<LabelMatcher[]>(() => (scope === null ? [] : [{ label: snapshot.groupLabel, op: "=", value: scope }]), [scope, snapshot.groupLabel])
  const rows = React.useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    const filtered = snapshot.labels.filter((label) => !needle || label.label.toLowerCase().includes(needle))
    return sort === "name" ? [...filtered].sort((a, b) => a.label.localeCompare(b.label)) : filtered
  }, [snapshot.labels, deferredQuery, sort])
  const filterKey = `${deferredQuery}\u0000${sort}\u0000${scope ?? ""}`
  // The page size resets with the filter, like Streams.
  const paging = pagingState.key === filterKey ? pagingState.size : PAGE_SIZE
  const setPaging = (size: number) => setPagingState({ key: filterKey, size })
  // A deep-linked label stays on the first page.
  const focusIndex = focus ? rows.findIndex((row) => row.label === focus) : -1
  const limit = Math.max(paging, focusIndex + 1)
  const visible = rows.slice(0, limit)

  const counts = React.useMemo(() => {
    let move = 0
    let drop = 0
    for (const label of snapshot.labels) {
      const advice = adviseLogLabel({ label: label.label, distinctValues: label.distinctValues, idLike: label.idLike, truncated: snapshot.labelsTruncated && label.distinctValues >= MAX_LABEL_VALUES })
      if (advice.kind === "label_to_metadata") move += 1
      if (advice.kind === "drop_label") drop += 1
    }
    return { move, drop }
  }, [snapshot])

  const toggle = (label: string) => {
    setExpanded((current) => (current === label ? null : label))
    if (focus && focus !== label) update({ label: null })
  }
  const { rowProps } = useRowCursor({
    count: visible.length,
    resetKey: filterKey,
    onOpen: (index) => {
      const row = visible[index]
      if (row) toggle(row.label)
    },
    // x moves the highlighted label to structured metadata (or back); guarded labels need the toggle's override.
    onToggle: (index) => {
      const row = visible[index]
      if (!row) return
      const guard = guardedLogLabel(row.label)
      if (guard) {
        toast.info(guard.title, { description: "Use the To metadata toggle to confirm moving it." })
        return
      }
      try {
        useAppStore.getState().toggleLogRule({ kind: "label_to_metadata", selector: { matchers: scopeMatchers }, label: row.label, origin: "user" })
      } catch (error) {
        toast.error("Couldn't change the rule", { description: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const noun = groupNoun(snapshot.groupLabel, false)
  return (
    <Page>
      <PageHeader
        title="Labels"
        description={
          <span className="flex flex-col gap-1">
            <span>
              {formatNumber(snapshot.labels.length)} stream labels. Every distinct combination is a <Term id="logStream">stream</Term>, so a label with
              many values multiplies them. Move ID-like labels to <Term id="structuredMetadata">structured metadata</Term>; drop labels that tell nothing
              apart.
              {counts.move || counts.drop ? (
                <>
                  {" "}
                  <span className="text-brand-ink">
                    {[counts.move ? `${counts.move} to move` : null, counts.drop ? `${counts.drop} to drop` : null].filter(Boolean).join(", ")}.
                  </span>
                </>
              ) : null}
            </span>
            <LogsSnapshotLine snapshot={snapshot} />
          </span>
        }
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <InputGroup className="sm:max-w-sm">
          <InputGroupInput placeholder="Filter labels…" aria-label="Filter labels" value={query} onChange={(event) => update({ q: event.target.value })} />
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <InputGroupText>{formatNumber(rows.length)}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <div className="flex items-center gap-2">
          <Select value={scope ?? ALL} onValueChange={(value) => update({ scope: value === ALL ? null : value })}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-60 sm:flex-none" aria-label="Rules apply to">
              <span className="text-muted-foreground">Apply to</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All streams</SelectItem>
              </SelectGroup>
              {snapshot.groups.length ? <SelectSeparator /> : null}
              <SelectGroup>
                <SelectLabel>One {noun}</SelectLabel>
                {snapshot.groups.map((group) => (
                  <SelectItem key={group.value} value={group.value}>
                    {group.value}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <SegmentedControl aria-label="Sort labels by" value={sort} onValueChange={(value) => update({ sort: value === "values" ? null : value })} options={SORT_OPTIONS} className="shrink-0" />
        </div>
      </div>
      {scope !== null ? (
        <p className="-mt-1 text-xs text-muted-foreground">
          Streams, bytes and rules are scoped to {snapshot.groupLabel}=&quot;{scope}&quot;; values are counted over all streams.
        </p>
      ) : null}
      <Card className="overflow-visible">
        <CardContent>
          {snapshot.labels.length === 0 ? (
            <EmptyState icon={TagSimpleIcon} title="No stream labels" description={`No labels had values in the last ${LOGS_RANGE_LABEL[snapshot.range]}.`} />
          ) : rows.length === 0 ? (
            <EmptyState icon={MagnifyingGlassIcon} title="No matching labels" description={`Nothing matches “${query}”.`} />
          ) : (
            <div className="flex flex-col gap-2">
              <Table containerClassName="overflow-x-clip">
                <TableHeader className="sticky top-[104px] z-10 bg-well shadow-[0_1px_0_var(--border)]">
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Values</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-[3px]">
                            Streams
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">Streams carrying the label, from Loki's index (index/stats).</TooltipContent>
                      </Tooltip>
                    </TableHead>
                    <TableHead className="hidden text-right md:table-cell" title={BYTES_NOTE}>
                      Per day
                    </TableHead>
                    <TableHead className="hidden lg:table-cell">Advice</TableHead>
                    <TableHead className="w-12 text-right sm:w-44">
                      <span className="sr-only sm:not-sr-only">Rule</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((stat, index) => (
                    <LabelRow
                      key={`${stat.label}|${scope ?? ""}`}
                      stat={stat}
                      index={index}
                      snapshot={snapshot}
                      scopeMatchers={scopeMatchers}
                      scopeName={scope}
                      open={expanded === stat.label}
                      focused={focus === stat.label}
                      rowProps={rowProps(index)}
                      onToggle={() => toggle(stat.label)}
                    />
                  ))}
                </TableBody>
              </Table>
              {rows.length > limit ? (
                <Button variant="ghost" size="sm" className="self-center" onClick={() => setPaging(limit + PAGE_SIZE)}>
                  Show more ({formatNumber(rows.length - limit)} remaining)
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

export function LabelsPage() {
  return <RequireLogsSnapshot>{(snapshot) => <LabelsList snapshot={snapshot} />}</RequireLogsSnapshot>
}
