import * as React from "react"

import {
  formatLe,
  parseLe,
  toBuckets,
  type CumulativePoint,
  type HistogramUnit,
} from "@/lib/core/histograms"
import { INF_BUCKET } from "@/lib/core/rules"
import { cn } from "@/lib/utils"

// Observations per bucket as bars, one per `le` (non-cumulative), with kept
// buckets in brand orange and dropped ones as faint outlines. Hovering or
// focusing a bar reads it out above the chart; clicking toggles it.

interface Bar {
  le: string
  lower: string | null
  share: number
  /** Observations merge into the next kept bucket when this one is dropped. */
  kept: boolean
}

function bars(
  les: string[],
  points: CumulativePoint[],
  kept: Set<string>
): { bars: Bar[]; total: number } {
  const values = new Map(points.map((point) => [point.le, point.value]))
  const buckets = toBuckets(
    les.map((le) => ({ le, value: values.get(le) ?? 0 }))
  )
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0
  return {
    total,
    bars: buckets.map((bucket, index) => ({
      le: bucket.le,
      lower: index ? buckets[index - 1].le : null,
      share:
        total > 0
          ? (bucket.cumulative - (index ? buckets[index - 1].cumulative : 0)) /
            total
          : 0,
      kept: kept.has(bucket.le) || bucket.le === INF_BUCKET,
    })),
  }
}

function percent(share: number) {
  if (share === 0) return "0%"
  if (share < 0.001) return "<0.1%"
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`
}

export function BucketChart({
  les,
  points,
  kept,
  unit,
  onToggle,
  height = 96,
  className,
}: {
  les: string[]
  points: CumulativePoint[]
  kept: Set<string>
  unit: HistogramUnit
  onToggle?: (le: string) => void
  height?: number
  className?: string
}) {
  const { bars: data, total } = React.useMemo(
    () => bars(les, points, kept),
    [les, points, kept]
  )
  const [active, setActive] = React.useState<number | null>(null)
  const max = Math.max(...data.map((bar) => bar.share), 0)
  const hovered = active === null ? null : data[active]
  const range = (bar: Bar) =>
    `${bar.lower === null ? (parseLe(bar.le) > 0 ? "0" : "−Inf") : formatLe(bar.lower, unit)} – ${formatLe(bar.le, unit)}`
  // Label only a few ticks so they never collide: kept bounds, thinned out on long lists.
  const every = Math.max(1, Math.ceil(data.length / 8))

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {/* The hover readout changes on every bar; inline-size containment keeps
          it from widening the column, which moved the bars under the pointer
          and made hover flicker. */}
      <div
        className="flex min-h-4 items-center justify-between gap-2 text-xs text-muted-foreground [contain:inline-size]"
        aria-live="polite"
      >
        {hovered ? (
          <span className="truncate">
            <span className="font-mono text-foreground">{range(hovered)}</span>{" "}
            ·{" "}
            {total > 0
              ? `${percent(hovered.share)} of observations`
              : "no observations"}{" "}
            ·{" "}
            {hovered.kept
              ? "kept"
              : "dropped, merges into the next kept bucket"}
          </span>
        ) : (
          <span className="truncate">
            {total > 0
              ? "Share of observations per bucket"
              : "No observations to weigh buckets by; spacing only"}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-[2px] bg-brand" aria-hidden />
            kept
          </span>
          <span className="flex items-center gap-1">
            <span
              className="size-2 rounded-[2px] border border-dashed border-muted-foreground/60"
              aria-hidden
            />
            dropped
          </span>
        </span>
      </div>
      <div
        className="flex items-end gap-0.5 border-b border-border"
        style={{ height }}
        role="group"
        aria-label="Observations per bucket"
        onMouseLeave={() => setActive(null)}
      >
        {data.map((bar, index) => {
          const locked = bar.le === INF_BUCKET
          const barHeight =
            max > 0
              ? Math.max(
                  bar.share > 0 ? 3 : 1,
                  (bar.share / max) * (height - 4)
                )
              : 6
          return (
            <button
              key={bar.le}
              type="button"
              disabled={!onToggle || locked}
              aria-pressed={bar.kept}
              aria-label={`${range(bar)}: ${percent(bar.share)} of observations, ${bar.kept ? "kept" : "dropped"}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              onClick={() => onToggle?.(bar.le)}
              className="group/bar flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-t-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
            >
              <span
                className={cn(
                  "w-full rounded-t-[3px] transition-[height,background-color,opacity] duration-300 motion-reduce:transition-none",
                  bar.kept
                    ? "bg-brand"
                    : "border border-b-0 border-dashed border-muted-foreground/50 bg-muted-foreground/10",
                  active === index && "opacity-80"
                )}
                style={{ height: barHeight }}
              />
            </button>
          )
        })}
      </div>
      <div className="flex gap-0.5" aria-hidden>
        {data.map((bar, index) => (
          <span
            key={bar.le}
            className={cn(
              "min-w-0 flex-1 overflow-visible text-center font-mono text-[10px] whitespace-nowrap",
              bar.kept ? "text-foreground" : "text-muted-foreground/70"
            )}
          >
            {index % every === 0 || index === data.length - 1
              ? formatLe(bar.le, unit)
              : ""}
          </span>
        ))}
      </div>
    </div>
  )
}
