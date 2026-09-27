import * as React from "react"
import { area, curveMonotoneX, line } from "d3-shape"
import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react"

import { FOCUS_KNOTS, ease, focusGradient, formatChange, nearestIndex, tooltipLeft, yScaleDomain } from "@/lib/core/chart"
import { cn } from "@/lib/utils"

export { yScaleDomain }

export interface ChartSeries {
  key: string
  label: string
  /** Any CSS color; used for the line, markers and tooltip dot. */
  color: string
  /** Draws a soft gradient area under the line. */
  fill?: boolean
  dashed?: boolean
  /**
   * The series this one estimates; the tooltip shows the difference against
   * it ("saving vs actual") instead of the change since the previous point.
   * Dashed series default to the first solid series.
   */
  baseline?: string
}

export interface ChartPoint {
  t: number
  values: Record<string, number | undefined>
}

interface SeriesChartProps {
  data: ChartPoint[]
  series: ChartSeries[]
  height?: number
  formatValue?: (value: number) => string
  formatTick?: (t: number) => string
  formatTooltipTitle?: (t: number) => string
  /** Axis labels; compact by default (15.8k). */
  formatAxis?: (value: number) => string
  /** Pins the bottom of the y-axis, e.g. 0. By default it floats around the data. */
  yMin?: number
  /** The smallest y span as a share of the max, so small wobbles stay small. */
  minSpan?: number
  className?: string
}

const PAD = { top: 20, right: 20, bottom: 44, left: 52 }
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const HIGHLIGHT_HALF_WIDTH = 64
/**
 * Hover focus: the plot stays crisp within `clear` px of the cursor, then
 * dims (to 1 - dim) and blurs through `blurs` px with distance, strongest at
 * `reach` (a share of the plot width, at least `minReach` px).
 */
const FOCUS = { clear: 48, reach: 0.6, minReach: 160, dim: 0.75, blurs: [1, 2, 4] } as const
const TOOLTIP_GUESS = 208

const spring = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 } as const
const focusSpring = { stiffness: 260, damping: 32, mass: 0.8 }

function useWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** Border-box width of an element that mounts and unmounts; keeps the last value. */
function useElementWidth(fallback: number) {
  const [element, setElement] = React.useState<HTMLElement | null>(null)
  const [width, setWidth] = React.useState(fallback)
  React.useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.offsetWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width] as const
}

/**
 * CSS masks for the focus layers, driven by `--fx` (focus x) and `--k` (focus
 * strength, 0 = no hover). The sharp layer and the blurred copies split each
 * point between them (weights sum to 1), and every layer also takes the
 * opacity fall-off. Reduced motion keeps only the opacity dim.
 */
function focusMasks(innerWidth: number, reduced: boolean) {
  const options = { clear: FOCUS.clear, reach: Math.max(FOCUS.minReach, innerWidth * FOCUS.reach) }
  const opacity = focusGradient(
    FOCUS_KNOTS.map((knot) => (knot === 0 ? 1 : `calc(1 - var(--k) * ${(FOCUS.dim * ease(knot)).toFixed(3)})`)),
    options
  )
  if (reduced) return { sharp: opacity, blurred: [] }
  const sharp = focusGradient(FOCUS_KNOTS.map((_, index) => (index === 0 ? 1 : "calc(1 - var(--k))")), options)
  const blurred = FOCUS.blurs.map((_, layer) => focusGradient(FOCUS_KNOTS.map((_, index) => (index === layer + 1 ? "var(--k)" : 0)), options))
  return { sharp: `${opacity}, ${sharp}`, blurred: blurred.map((mask) => `${opacity}, ${mask}`) }
}

function maskStyle(mask: string, blur?: number): React.CSSProperties {
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
    filter: blur ? `blur(${blur}px)` : undefined,
    willChange: blur ? "transform" : undefined,
  }
}

/**
 * Line/area chart in the Cardinal style: a dotted canvas, lines drawn in on
 * mount, and on hover a focus around the cursor (the plot dims and blurs with
 * distance), a crisp crosshair, highlighted segment, dark tooltip and a date
 * pill on the axis. On touch, tap to pin the tooltip and tap outside to dismiss it.
 */
export function SeriesChart({
  data,
  series,
  height = 320,
  formatValue = (value) => Math.round(value).toLocaleString(),
  formatTick = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  formatTooltipTitle = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  formatAxis = (value) => compact.format(value),
  yMin,
  minSpan,
  className,
}: SeriesChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = React.useState<number | null>(null)
  const [pinned, setPinned] = React.useState(false)
  const [setTooltipEl, tooltipWidth] = useElementWidth(TOOLTIP_GUESS)
  const [setPillEl, pillWidth] = useElementWidth(64)
  const reduceMotion = !!useReducedMotion()
  const id = React.useId().replace(/:/g, "")

  const innerWidth = Math.max(0, width - PAD.left - PAD.right)
  const innerHeight = height - PAD.top - PAD.bottom
  const plotRight = PAD.left + innerWidth
  const highlightHalf = Math.min(HIGHLIGHT_HALF_WIDTH, innerWidth * 0.1)

  const { xOf, yOf, yTicks } = React.useMemo(() => {
    const minT = data[0]?.t ?? 0
    const maxT = data[data.length - 1]?.t ?? 1
    let max = 0
    let min = Infinity
    for (const point of data) {
      for (const s of series) {
        const value = point.values[s.key]
        if (value === undefined) continue
        max = Math.max(max, value)
        min = Math.min(min, value)
      }
    }
    if (!Number.isFinite(min)) min = 0
    const { low, high, ticks } = yScaleDomain(min, max, { yMin, minSpan })
    return {
      yTicks: ticks,
      xOf: (t: number) => PAD.left + (maxT === minT ? innerWidth / 2 : ((t - minT) / (maxT - minT)) * innerWidth),
      yOf: (value: number) => PAD.top + innerHeight - ((value - low) / (high - low)) * innerHeight,
    }
  }, [data, series, innerWidth, innerHeight, yMin, minSpan])

  const xs = React.useMemo(() => data.map((point) => xOf(point.t)), [data, xOf])

  const paths = React.useMemo(
    () =>
      series.map((s) => {
        const defined = (point: ChartPoint) => point.values[s.key] !== undefined
        const lineGen = line<ChartPoint>()
          .defined(defined)
          .x((point) => xOf(point.t))
          .y((point) => yOf(point.values[s.key]!))
          .curve(curveMonotoneX)
        const areaGen = area<ChartPoint>()
          .defined(defined)
          .x((point) => xOf(point.t))
          .y0(PAD.top + innerHeight)
          .y1((point) => yOf(point.values[s.key]!))
          .curve(curveMonotoneX)
        return { series: s, line: lineGen(data) ?? "", area: s.fill ? (areaGen(data) ?? "") : "" }
      }),
    [series, data, xOf, yOf, innerHeight]
  )

  const baselineOf = React.useMemo(() => {
    const solid = series.find((s) => !s.dashed)
    return (s: ChartSeries) => s.baseline ?? (s.dashed && solid ? solid.key : undefined)
  }, [series])

  const ticks = React.useMemo(() => {
    if (data.length < 2) return data.map((point) => point.t)
    const count = Math.min(5, data.length)
    return Array.from({ length: count }, (_, i) => data[Math.round((i / (count - 1)) * (data.length - 1))].t)
  }, [data])

  // A pinned (tapped) tooltip stays until a tap lands outside the chart.
  React.useEffect(() => {
    if (!pinned) return
    const onDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setPinned(false)
      setHover(null)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [pinned, ref])

  const hoverAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = nearestIndex(xs, event.clientX - rect.left)
    if (index >= 0) setHover(index)
  }

  const active = hover !== null ? data[hover] : null
  const previous = hover !== null && hover > 0 ? data[hover - 1] : null
  const activeX = active ? xOf(active.t) : 0
  const { left: tipLeft } = tooltipLeft({ anchor: activeX, width: tooltipWidth, bounds: width })
  const pillLeft = Math.min(Math.max(activeX - pillWidth / 2, 4), Math.max(4, width - pillWidth - 4))
  const pillCenter = pillLeft + pillWidth / 2
  const follow = reduceMotion ? { duration: 0 } : spring

  // The focus follows the active point on a spring and fades out when hover ends;
  // both live in CSS variables, so moving it never re-renders the layers.
  const focusX = useSpring(0, focusSpring)
  const focusK = useSpring(0, focusSpring)
  const focusXPx = useTransform(focusX, (x) => `${x}px`)
  const hovering = active !== null
  React.useEffect(() => {
    if (!hovering) {
      if (reduceMotion) focusK.jump(0)
      else focusK.set(0)
      return
    }
    if (reduceMotion || focusK.get() < 0.02) focusX.jump(activeX)
    else focusX.set(activeX)
    if (reduceMotion) focusK.jump(1)
    else focusK.set(1)
  }, [hovering, activeX, reduceMotion, focusX, focusK])

  const masks = React.useMemo(() => focusMasks(innerWidth, reduceMotion), [innerWidth, reduceMotion])

  // Dots, area and lines: drawn once per layer, never re-rendered on hover.
  const plot = React.useMemo(
    () => (
      <>
        <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} fill={`url(#dots-${id})`} mask={`url(#dots-fade-${id})`} />
        <g clipPath={`url(#reveal-${id})`}>
          {paths.map(({ series: s, area: areaPath }) => (areaPath ? <path key={`a-${s.key}`} d={areaPath} fill={`url(#area-${s.key}-${id})`} /> : null))}
          {paths.map(({ series: s, line: linePath }) => (
            <path key={`l-${s.key}`} d={linePath} fill="none" stroke={s.color} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray={s.dashed ? "4 4" : undefined} />
          ))}
        </g>
      </>
    ),
    [paths, id, innerWidth, innerHeight]
  )

  return (
    <div ref={ref} className={cn("relative w-full select-none", className)} style={{ height }}>
      {width > 0 ? (
        <>
          <svg width={width} height={height} className="absolute inset-0 block" aria-hidden>
            <defs>
              <pattern id={`dots-${id}`} width="12" height="12" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.9" className="fill-foreground/[0.09]" />
              </pattern>
              <linearGradient id={`dots-fade-x-${id}`} gradientUnits="userSpaceOnUse" x1={PAD.left} x2={plotRight} y1={0} y2={0}>
                <stop offset={0} stopColor="white" stopOpacity={0} />
                <stop offset={0.04} stopColor="white" stopOpacity={1} />
                <stop offset={0.96} stopColor="white" stopOpacity={1} />
                <stop offset={1} stopColor="white" stopOpacity={0} />
              </linearGradient>
              <mask id={`dots-fade-${id}`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
                <rect x={PAD.left} width={innerWidth} height={height} fill={`url(#dots-fade-x-${id})`} />
              </mask>
              {paths.map(({ series: s }) => (
                <linearGradient key={s.key} id={`area-${s.key}-${id}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity="0.18" />
                  <stop offset="1" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
              <clipPath id={`reveal-${id}`}>
                <motion.rect x={0} y={0} height={height} initial={{ width: 0 }} animate={{ width }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
              </clipPath>
            </defs>

            {yTicks.map((value) => {
              const y = Math.round(yOf(value)) + 0.5
              return (
                <g key={value}>
                  <line x1={PAD.left} x2={plotRight} y1={y} y2={y} className="stroke-foreground/[0.08]" strokeWidth={1} />
                  <text x={PAD.left - 10} y={y} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                    {formatAxis(value)}
                  </text>
                </g>
              )
            })}

            {ticks.map((t) => {
              const x = xOf(t)
              const hidden = active && Math.abs(x - pillCenter) < pillWidth / 2 + 28
              return (
                <text
                  key={t}
                  x={x}
                  y={height - 14}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px] transition-opacity duration-200"
                  style={{ opacity: hidden ? 0 : 1 }}
                >
                  {formatTick(t)}
                </text>
              )
            })}
          </svg>

          <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ "--fx": focusXPx, "--k": focusK } as React.ComponentProps<typeof motion.div>["style"]}>
            {FOCUS.blurs.map((blur, index) =>
              masks.blurred[index] ? (
                <svg key={blur} width={width} height={height} className="absolute inset-0 block" style={maskStyle(masks.blurred[index], blur)}>
                  {plot}
                </svg>
              ) : null
            )}
            <svg width={width} height={height} className="absolute inset-0 block" style={maskStyle(masks.sharp)}>
              {plot}
            </svg>
          </motion.div>

          <svg
            width={width}
            height={height}
            className="absolute inset-0 block touch-pan-y"
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") return
              setPinned(true)
              hoverAt(event)
            }}
            onPointerMove={hoverAt}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse" && !pinned) setHover(null)
            }}
            onPointerCancel={() => {
              // The finger started a scroll, not a tap.
              setPinned(false)
              setHover(null)
            }}
          >
            <defs>
              <clipPath id={`window-${id}`}>
                <rect x={activeX - highlightHalf} y={0} width={highlightHalf * 2} height={height} />
              </clipPath>
            </defs>
            {active ? (
              <>
                <g clipPath={`url(#window-${id})`}>
                  {paths.map(({ series: s, line: linePath }) => (
                    <path key={`h-${s.key}`} d={linePath} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "4 4" : undefined} />
                  ))}
                </g>
                <line x1={activeX} x2={activeX} y1={PAD.top - 16} y2={PAD.top + innerHeight + 6} className="stroke-brand" strokeWidth={1} />
                {series.map((s) => {
                  const value = active.values[s.key]
                  if (value === undefined) return null
                  return <circle key={s.key} cx={activeX} cy={yOf(value)} r={4} fill={s.color} className="stroke-background" strokeWidth={2} />
                })}
              </>
            ) : null}
          </svg>
        </>
      ) : null}

      <AnimatePresence>
        {active ? (
          <motion.div
            key="pill"
            ref={setPillEl}
            className="pointer-events-none absolute left-0 rounded-full bg-foreground px-3 py-1 text-xs font-medium whitespace-nowrap text-background shadow-sm"
            style={{ top: height - 32 }}
            initial={{ opacity: 0, scale: 0.9, x: pillLeft }}
            animate={{ opacity: 1, scale: 1, x: pillLeft }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ opacity: { duration: 0.15 }, scale: spring, x: follow }}
          >
            {formatTick(active.t)}
          </motion.div>
        ) : null}
        {active ? (
          <motion.div
            key="tooltip"
            ref={setTooltipEl}
            role="status"
            className="pointer-events-none absolute top-3 left-0 w-max max-w-[min(17rem,calc(100%-1rem))] min-w-48 rounded-xl border border-tooltip-border bg-tooltip-surface/95 px-3 pt-2 pb-2.5 text-xs text-white shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_rgba(0,0,0,0.25)] backdrop-blur"
            initial={{ opacity: 0, y: 4, scale: 0.96, filter: "blur(4px)", x: tipLeft }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)", x: tipLeft }}
            exit={{ opacity: 0, y: 4, scale: 0.96, filter: "blur(4px)" }}
            transition={{ default: { type: "spring", bounce: 0.1, duration: 0.3 }, x: follow }}
          >
            <div className="mb-1.5 text-[11px] font-medium text-white/50 tabular-nums">{formatTooltipTitle(active.t)}</div>
            <div className="flex flex-col gap-1.5">
              {series.map((s) => {
                const value = active.values[s.key]
                if (value === undefined) return null
                const baselineKey = baselineOf(s)
                const baseline = baselineKey ? active.values[baselineKey] : undefined
                const before = previous?.values[s.key]
                const detail =
                  baseline !== undefined
                    ? { note: "saving vs actual", text: formatChange(value - baseline, baseline, formatValue) }
                    : before !== undefined
                      ? { note: "vs previous", text: formatChange(value - before, before, formatValue) }
                      : null
                return (
                  <div key={s.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2">
                    <span
                      className={cn("size-2 rounded-full", s.dashed && "border-[1.5px] border-dotted")}
                      style={s.dashed ? { borderColor: s.color } : { background: s.color }}
                    />
                    <span className="truncate text-white/70">{s.label}</span>
                    <span className="text-[13px] font-medium tabular-nums">{formatValue(value)}</span>
                    {detail ? (
                      <span className="col-start-2 col-end-4 flex justify-between gap-3 text-[11px] text-white/45 tabular-nums">
                        <span>{detail.note}</span>
                        <span className={cn(baseline !== undefined && value < baseline && "text-brand")}>{detail.text}</span>
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
