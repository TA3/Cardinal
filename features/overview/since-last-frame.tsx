import * as React from "react"
import { ClockCounterClockwiseIcon, TrendUpIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { SwapText } from "@/components/motion"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"
import type { Snapshot } from "@/lib/core/snapshot"
import { useAppStore, type SnapshotSummary } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

interface Change {
  metric: string
  before: number
  after: number
  delta: number
}

const SHOWN = 5

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

/** Growers and new metrics between the previous snapshot summary and the current snapshot. */
export function diffSnapshots(previous: SnapshotSummary, snapshot: Snapshot) {
  // With a truncated summary, a missing metric smaller than the smallest kept one may simply have been cut.
  const floor = previous.truncated ? Math.min(...Object.values(previous.metrics)) : 0
  const growers: Change[] = []
  const added: Change[] = []
  const now = new Set<string>()
  for (const metric of snapshot.metrics) {
    now.add(metric.metric)
    const before = Object.hasOwn(previous.metrics, metric.metric) ? previous.metrics[metric.metric] : undefined
    if (before === undefined) {
      if (metric.seriesCount > floor) added.push({ metric: metric.metric, before: 0, after: metric.seriesCount, delta: metric.seriesCount })
    } else if (metric.seriesCount > before) {
      growers.push({ metric: metric.metric, before, after: metric.seriesCount, delta: metric.seriesCount - before })
    }
  }
  const gone = Object.keys(previous.metrics).filter((metric) => !now.has(metric)).length
  growers.sort((a, b) => b.delta - a.delta)
  added.sort((a, b) => b.delta - a.delta)
  return { growers, added, gone, totalDelta: snapshot.totalSeries - previous.totalSeries }
}

function ChangeList({ title, items, total, fresh }: { title: string; items: Change[]; total: number; fresh?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{title}</span>
        {total > items.length ? <span className="tabular-nums">+{total - items.length} more</span> : null}
      </div>
      {items.length ? (
        items.map((item) => (
          <Link
            key={item.metric}
            to={metricPath(item.metric)}
            title={fresh ? `${item.metric}: new, ${item.after.toLocaleString()} series` : `${item.metric}: ${item.before.toLocaleString()} → ${item.after.toLocaleString()}`}
            className="-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-1 text-sm outline-none transition-colors hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", fresh ? "bg-brand" : "bg-brand/50")} />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{item.metric}</span>
            <span className="shrink-0 text-brand-ink tabular-nums">{formatDelta(item.delta)}</span>
          </Link>
        ))
      ) : (
        <p className="py-1 text-sm text-muted-foreground">None</p>
      )}
    </div>
  )
}

/** "Since last snapshot": what grew, and which metrics are new, since the snapshot this one replaced. */
export function SinceLastFrame({ snapshot }: { snapshot: Snapshot }) {
  const previous = useAppStore((state) => state.previousSnapshotSummary)
  const diff = React.useMemo(() => (previous ? diffSnapshots(previous, snapshot) : null), [previous, snapshot])
  const when = ago(previous?.capturedAt)

  return (
    <Frame className="h-full">
      <FrameHeader icon={ClockCounterClockwiseIcon} title="Since last snapshot" meta={when ? `vs ${when}` : undefined} />
      <FrameWell className="flex flex-col gap-3">
        {!previous || !diff ? (
          <EmptyState
            compact
            icon={TrendUpIcon}
            title="One snapshot so far"
            description="Refresh later to see which metrics grew and which are new."
          />
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className={cn("text-2xl font-medium tracking-tight tabular-nums", diff.totalDelta > 0 && "text-brand-ink")}>
                <SwapText value={formatDelta(diff.totalDelta)} />
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {previous.totalSeries.toLocaleString()} → {snapshot.totalSeries.toLocaleString()}
              </span>
            </div>
            <ChangeList title="Grew most" items={diff.growers.slice(0, SHOWN)} total={diff.growers.length} />
            <ChangeList title="New metrics" items={diff.added.slice(0, SHOWN)} total={diff.added.length} fresh />
            {diff.gone ? (
              <p className="text-xs text-muted-foreground">
                {diff.gone} metric{diff.gone === 1 ? "" : "s"} no longer reported{previous.truncated ? " (of the previous top 500)" : ""}.
              </p>
            ) : null}
          </>
        )}
      </FrameWell>
    </Frame>
  )
}
