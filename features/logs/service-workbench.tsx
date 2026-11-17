import * as React from "react"
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  MagnifyingGlassIcon,
  PercentIcon,
  ProhibitIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react"

import { useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { LogRuleToggle } from "@/components/log-rule-toggle"
import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { nextOpenIndex, useShownIndex, WorkDialog } from "@/components/work-dialog"
import { PatternDetail, PatternText, levelTone, patternTableRows, type PatternTableRow } from "@/features/logs/pattern-table"
import { usePatterns } from "@/features/logs/patterns-data"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { buildServiceWork, serviceKeptKey, type PatternWork, type ServiceWork } from "@/lib/core/logs/service-work"
import type { LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// A service (a stream group), worked through by hand like a metrics job: on
// top what its cuts save and the service-wide actions; below every pattern
// Loki found in its lines, each opening a dialog with recent lines and Drop,
// Sample or Protect.

const NONE: string[] = []

export function useServiceWork(snapshot: LogsSnapshot, by: string, group: string, selector: StreamSelector, bytesPerDay: number | null) {
  const patterns = usePatterns(by, group, "1h")
  const rules = useAppStore((state) => state.logRules)
  const key = serviceKeptKey(by, group)
  const kept = useAppStore((state) => (Object.hasOwn(state.keptAsIs, key) ? state.keptAsIs[key] : NONE))
  const rows = React.useMemo(() => patternTableRows(snapshot, by, group, patterns.data).rows, [snapshot, by, group, patterns.data])
  const work = React.useMemo(
    () => buildServiceWork({ selector, patterns: rows, rules, kept, bytesPerDay }),
    [selector, rows, rules, kept, bytesPerDay]
  )
  return { work, rows, patterns, keptKey: key }
}

export function ServiceSummary({
  work,
  selector,
  bytesPerDay,
}: {
  work: ServiceWork
  selector: StreamSelector
  bytesPerDay: number | null
}) {
  const { format } = useBytesCost()
  const total = work.patterns.length
  const saved = work.savedBytesPerDay
  const after = bytesPerDay === null ? null : Math.max(0, bytesPerDay - saved)
  const percent = bytesPerDay ? (saved / bytesPerDay) * 100 : 0
  const cost = saved ? format(saved, "day") : null

  return (
    <Frame>
      <FrameWell className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">With your cuts</span>
            <span className="text-2xl font-medium tracking-tight tabular-nums">
              {bytesPerDay === null ? (
                saved ? `~−${formatBytes(saved)}/day` : "—"
              ) : saved ? (
                <>
                  {formatBytes(bytesPerDay)}
                  <span className="text-muted-foreground"> → </span>~{formatBytes(after!)}
                  <span className="text-sm font-normal text-muted-foreground">/day</span>
                  <span className="ml-2 text-sm font-medium text-brand-ink">
                    −{percent < 1 ? percent.toFixed(1) : Math.round(percent)}%{cost ? ` · ${cost}` : ""}
                  </span>
                </>
              ) : (
                <>
                  {formatBytes(bytesPerDay)}
                  <span className="text-sm font-normal text-muted-foreground">/day, nothing cut yet</span>
                </>
              )}
            </span>
          </div>
          {total ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatNumber(work.done)} of {formatNumber(total)} patterns done
            </span>
          ) : null}
        </div>
        {total ? <Progress value={(work.done / total) * 100} aria-label="Patterns done" className="h-1.5" /> : null}
      </FrameWell>
      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2.5 pb-2">
        <LogRuleToggle kind="drop_lines" selector={selector} />
        <LogRuleToggle kind="sample" selector={selector} />
        <LogRuleToggle kind="drop_streams" selector={selector} hint={bytesPerDay !== null ? `−${formatBytes(bytesPerDay)}/day` : undefined} />
        <LogRuleToggle kind="keep" selector={selector} />
      </div>
    </Frame>
  )
}

type Show = "open" | "done" | "all"

const STATE_TEXT: Record<PatternWork["state"], string> = {
  open: "",
  kept: "kept as is",
  dropped: "dropped",
  sampled: "sampled",
  protected: "protected",
}

function stateText(item: PatternWork) {
  if (item.state === "sampled" && item.rule?.kind === "sample") return `keeps ${Math.round(item.rule.keep * 100)}%`
  if (item.state === "dropped" && item.rule?.kind === "drop_lines" && item.rule.line.levels?.length) return `dropped with ${item.rule.line.levels.join(" and ")} lines`
  if (item.state === "dropped" && item.rule?.kind === "drop_streams") return "the whole service is dropped"
  return STATE_TEXT[item.state]
}

function StateIcon({ state }: { state: PatternWork["state"] }) {
  const className = "mt-0.5 size-4 shrink-0"
  if (state === "dropped") return <ProhibitIcon className={cn(className, "text-destructive")} aria-hidden />
  if (state === "sampled") return <PercentIcon className={cn(className, "text-brand-ink")} aria-hidden />
  if (state === "protected") return <ShieldCheckIcon className={cn(className, "text-muted-foreground")} aria-hidden />
  if (state === "kept") return <CheckCircleIcon className={cn(className, "text-muted-foreground")} aria-hidden />
  return <CircleIcon className={cn(className, "text-muted-foreground/40")} aria-hidden />
}

export function PatternWorklist({
  by,
  group,
  work,
  rows,
  patterns,
  keptKey,
}: {
  by: string
  group: string
  work: ServiceWork
  rows: PatternTableRow[]
  patterns: ReturnType<typeof usePatterns>
  keptKey: string
}) {
  const left = work.patterns.length - work.done
  const [show, setShow] = React.useState<Show>("open")
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState<{ queue: string[]; index: number } | null>(null)
  const needle = query.trim().toLowerCase()
  const visible = work.patterns.filter(
    (item) => (show === "all" || (show === "open") === (item.state === "open")) && (!needle || item.pattern.toLowerCase().includes(needle))
  )
  const openAt = (index: number) => setOpen({ queue: visible.map((item) => item.pattern), index })
  const { rowProps } = useRowCursor({ count: visible.length, resetKey: `${show}\u0000${needle}`, onOpen: openAt })
  const byPattern = React.useMemo(() => new Map(work.patterns.map((item) => [item.pattern, item])), [work.patterns])
  const rowByPattern = React.useMemo(() => new Map(rows.map((row) => [row.pattern, row])), [rows])

  if (patterns.isPending) {
    return (
      <Frame>
        <FrameHeader title="Patterns" meta="reading the last hour…" />
        <FrameWell className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-10" />
          ))}
        </FrameWell>
      </Frame>
    )
  }
  if (patterns.error || patterns.data?.patterns === null || work.patterns.length === 0) {
    return (
      <Frame>
        <FrameHeader title="Patterns" />
        <FrameWell>
          <EmptyState
            compact
            icon={MagnifyingGlassIcon}
            title={patterns.error ? "Couldn't read patterns" : patterns.data?.patterns === null ? "No pattern ingester" : "No patterns in the last hour"}
            description={
              patterns.error
                ? authErrorText(patterns.error, "logs")
                : patterns.data?.patterns === null
                  ? "This Loki doesn't run the pattern ingester, so lines can't be grouped. The buttons above still drop or sample the whole service."
                  : `Loki found no repeated lines for ${group} in the last hour.`
            }
          />
        </FrameWell>
      </Frame>
    )
  }

  return (
    <Frame>
      <FrameHeader
        title="Patterns"
        meta={<span className="hidden sm:inline">repeated lines, largest first · open one to see what you can do</span>}
        action={
          <SegmentedControl
            size="sm"
            className="shrink-0"
            aria-label="Which patterns to show"
            value={show}
            onValueChange={setShow}
            options={[
              { value: "open", label: `To do ${formatNumber(left)}` },
              { value: "done", label: `Done ${formatNumber(work.done)}` },
              { value: "all", label: "All" },
            ]}
          />
        }
      />
      <FrameWell className="flex flex-col gap-2 px-2 py-2">
        <label className="mx-1 flex h-8 items-center gap-1.5 rounded-full border border-input bg-background px-3 text-sm sm:max-w-xs">
          <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter patterns"
            aria-label="Filter patterns"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        {visible.length === 0 ? (
          <EmptyState
            compact
            icon={needle ? MagnifyingGlassIcon : CheckCircleIcon}
            title={needle ? "No matching pattern" : show === "open" ? "Every pattern is done" : "Nothing done yet"}
            description={
              needle ? `Nothing matches “${query}”.` : show === "open" ? "Each pattern is cut, protected or kept as is." : "Open a pattern to cut it, or keep it as is."
            }
          >
            {!needle && show === "open" ? (
              <Button size="sm" variant="outline" onClick={() => setShow("all")}>
                Show all
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <ul className="flex flex-col">
            {visible.map((item, index) => {
              const text = stateText(item)
              const tone = levelTone(item.level)
              return (
                <li key={item.pattern}>
                  <button
                    type="button"
                    {...rowProps(index)}
                    onClick={() => openAt(index)}
                    className={cn(
                      "group/row flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/50",
                      CURSOR_ROW_CLASS,
                      "data-[cursor=true]:bg-background/70"
                    )}
                  >
                    <StateIcon state={item.state} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn("line-clamp-2", item.state === "dropped" && "opacity-60")}>
                        <PatternText pattern={item.pattern} className="text-[12px]" />
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        {tone ? (
                          <Badge variant="outline" className={cn("h-4 px-1 text-[10px]", tone)}>
                            {item.level}
                          </Badge>
                        ) : null}
                        {text ? <span>{text}</span> : null}
                        {item.regex === null ? <span>too broad to cut on its own</span> : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end tabular-nums">
                      <span className="text-sm">{(item.lineShare * 100).toFixed(item.lineShare < 0.01 ? 2 : 1)}%</span>
                      {item.savedBytesPerDay > 0 ? (
                        <span className="text-[11px] text-brand-ink">−{formatBytes(item.savedBytesPerDay)}/day</span>
                      ) : item.bytesPerDay !== null ? (
                        <span className="text-[11px] text-muted-foreground">~{formatBytes(item.bytesPerDay)}/day</span>
                      ) : null}
                    </span>
                    <CaretRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/row:translate-x-0.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="px-2 text-[11px] text-muted-foreground">
          Shares are of the lines Loki's pattern ingester saw in the last hour; bytes assume average line length.
        </p>
      </FrameWell>
      <PatternWorkDialog
        by={by}
        group={group}
        queue={open?.queue ?? []}
        index={open?.index ?? null}
        byPattern={byPattern}
        rowByPattern={rowByPattern}
        keptKey={keptKey}
        onIndex={(index) => setOpen((current) => (current ? { ...current, index } : current))}
        onClose={() => setOpen(null)}
      />
    </Frame>
  )
}

function PatternWorkDialog({
  by,
  group,
  queue,
  index,
  byPattern,
  rowByPattern,
  keptKey,
  onIndex,
  onClose,
}: {
  by: string
  group: string
  queue: string[]
  index: number | null
  byPattern: Map<string, PatternWork>
  rowByPattern: Map<string, PatternTableRow>
  keptKey: string
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const position = useShownIndex(index)
  const pattern = queue[position]
  const item = pattern === undefined ? undefined : byPattern.get(pattern)
  const row = pattern === undefined ? undefined : rowByPattern.get(pattern)
  const setKeptAsIs = useAppStore((state) => state.setKeptAsIs)

  return (
    <WorkDialog
      open={index !== null && item !== undefined && row !== undefined}
      position={position}
      total={queue.length}
      noun="pattern"
      state={item === undefined ? undefined : item.state === "open" || item.state === "kept" ? item.state : "done"}
      onStep={(step) => onIndex(position + step)}
      onKeepAsIs={() => {
        if (!item) return
        setKeptAsIs(keptKey, item.pattern, true)
        const next = nextOpenIndex(queue, position, (name) => byPattern.get(name)?.state === "open")
        if (next === -1) onClose()
        else onIndex(next)
      }}
      onUndoKeep={() => item && setKeptAsIs(keptKey, item.pattern, false)}
      onClose={onClose}
      className="top-4 grid max-h-[calc(100svh-2rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:top-[10svh] sm:max-h-[80svh] sm:max-w-3xl"
    >
      {item && row ? (
        <React.Fragment key={item.pattern}>
          <DialogHeader className="border-b border-border/60 p-5 pb-4">
            <DialogTitle className="pr-6 text-sm font-normal">
              <span className="line-clamp-4">
                <PatternText pattern={item.pattern} />
              </span>
            </DialogTitle>
            <DialogDescription className="tabular-nums">
              {item.level && item.level !== "unknown" ? `${item.level} · ` : ""}
              {(item.lineShare * 100).toFixed(1)}% of {group}'s lines
              {item.bytesPerDay !== null ? ` · ~${formatBytes(item.bytesPerDay)}/day` : ""}
              {item.state !== "open" ? ` · ${stateText(item)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto p-3 sm:p-4">
            <PatternDetail row={row} groupLabel={by} range="1h" showOpen={false} className="p-0" />
          </div>
        </React.Fragment>
      ) : null}
    </WorkDialog>
  )
}
