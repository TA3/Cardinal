import * as React from "react"
import {
  CheckIcon,
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react"

import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import type { KeepListCut } from "@/lib/core/cut-plan"
import { jobLabel } from "@/lib/core/jobs"
import { SELF_METRIC } from "@/lib/core/keep-list"
import { cn } from "@/lib/utils"

// Reviewing a keep-list before it goes in: every metric of the job, what
// Cardinal suggests (keep what is read, drop what isn't) and a tick to keep
// anything it would drop.

type Show = "dropped" | "kept"

function usageText(used: boolean | undefined, metric: string) {
  if (used === true)
    return { text: "read by a dashboard or rule", tone: "text-brand-ink" }
  if (used === undefined)
    return { text: "couldn't be checked", tone: "text-muted-foreground" }
  return {
    text: SELF_METRIC.test(metric)
      ? "nothing reads it · exporter's own"
      : "nothing reads it",
    tone: "text-muted-foreground",
  }
}

export function KeepListDialog({
  open,
  onOpenChange,
  cut,
  used,
  onConfirm,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cut: KeepListCut
  used: Record<string, boolean | undefined>
  onConfirm: (keep: string[]) => void
  /** Takes the keep-list in the plan out again; offered only when there is one. */
  onRemove?: () => void
}) {
  const all = React.useMemo(
    () => [
      ...cut.drop,
      ...cut.keep.map((metric) => ({
        metric,
        seriesCount: seriesOf(cut, metric),
      })),
    ],
    [cut]
  )
  const [keep, setKeep] = React.useState(() => new Set(cut.keep))
  // Nothing dropped yet (no usage known): start on what is kept, to untick from there.
  const [show, setShow] = React.useState<Show>(() =>
    cut.drop.length ? "dropped" : "kept"
  )
  const [filter, setFilter] = React.useState("")

  const rows = all
    .filter((item) => (show === "kept") === keep.has(item.metric))
    .filter((item) => !filter || item.metric.includes(filter.trim()))
    .sort(
      (a, b) =>
        b.seriesCount - a.seriesCount || a.metric.localeCompare(b.metric)
    )
  const dropped = all.filter((item) => !keep.has(item.metric))
  const saved = dropped.reduce((sum, item) => sum + item.seriesCount, 0)
  const toggle = (metric: string) =>
    setKeep((previous) => {
      const next = new Set(previous)
      if (next.has(metric)) next.delete(metric)
      else next.add(metric)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <FunnelSimpleIcon
              className="size-4 text-brand-ink"
              weight="bold"
              aria-hidden
            />
            Keep-list for {jobLabel(cut.job)}
          </DialogTitle>
          <DialogDescription>
            Ticked metrics stay. Everything else is dropped at scrape, including
            metrics a new exporter version adds later.
            {all.some((item) => used[item.metric] === true)
              ? " Cardinal ticked what dashboards and rules read, and what it couldn't check."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <SegmentedControl
            size="sm"
            aria-label="Which metrics to show"
            value={show}
            onValueChange={setShow}
            options={[
              {
                value: "dropped",
                label: `Dropped ${formatNumber(dropped.length)}`,
              },
              {
                value: "kept",
                label: `Kept ${formatNumber(all.length - dropped.length)}`,
              },
            ]}
          />
          <div className="flex items-center gap-0.5 text-xs">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setKeep(new Set(all.map((item) => item.metric)))}
            >
              Keep all
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setKeep(new Set())}>
              Drop all
            </Button>
          </div>
          <label className="ml-auto flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-input px-2.5 text-xs sm:max-w-56">
            <MagnifyingGlassIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter metrics"
              aria-label="Filter metrics"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <ul className="flex flex-col gap-0.5 overflow-y-auto p-2">
          {rows.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {filter
                ? "No metric matches."
                : show === "dropped"
                  ? "Nothing is dropped."
                  : "Nothing is kept."}
            </li>
          ) : null}
          {rows.map((item) => {
            const kept = keep.has(item.metric)
            const usage = usageText(used[item.metric], item.metric)
            return (
              <li key={item.metric}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={kept}
                  onClick={() => toggle(item.metric)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                      kept
                        ? "border-foreground bg-foreground text-background"
                        : "border-foreground/25"
                    )}
                  >
                    {kept ? (
                      <CheckIcon className="size-3" weight="bold" />
                    ) : null}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={item.metric}
                  >
                    {item.metric}
                  </span>
                  <span
                    className={cn(
                      "hidden shrink-0 text-[11px] sm:inline",
                      usage.tone
                    )}
                  >
                    {usage.text}
                  </span>
                  <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                    {formatNumber(item.seriesCount)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-2 border-t border-border/60 p-4">
          <span className="text-xs text-muted-foreground tabular-nums">
            Keeps {formatNumber(all.length - dropped.length)}, drops{" "}
            {formatNumber(dropped.length)}{" "}
            <span className="font-medium text-brand-ink">
              {formatDelta(-saved)} series
            </span>
          </span>
          <div className="flex gap-2">
            {cut.rule && onRemove ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  onRemove()
                  onOpenChange(false)
                }}
              >
                Remove
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button
              onClick={() => {
                onConfirm(
                  all
                    .filter((item) => keep.has(item.metric))
                    .map((item) => item.metric)
                )
                onOpenChange(false)
              }}
            >
              {cut.state === "active" ? "Update keep-list" : "Add keep-list"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function seriesOf(cut: KeepListCut, metric: string) {
  return Object.hasOwn(cut.series, metric) ? cut.series[metric] : 0
}
