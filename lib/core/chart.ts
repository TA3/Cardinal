function niceStep(raw: number) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

/** A y domain snapped to round ticks, never tighter than `minSpan` of the max. */
export function yScaleDomain(min: number, max: number, { yMin, minSpan = 0.1 }: { yMin?: number; minSpan?: number } = {}) {
  const span = Math.max(max - min, Math.abs(max) * minSpan, 1)
  const center = (max + min) / 2
  const rawLow = yMin ?? Math.max(0, center - span * 0.6)
  const rawHigh = Math.max(rawLow + span * 1.2, max + span * 0.1)
  const step = niceStep((rawHigh - rawLow) / 3)
  const low = yMin ?? Math.floor(rawLow / step) * step
  const high = Math.ceil(rawHigh / step) * step
  const ticks: number[] = []
  for (let value = low; value <= high + step / 2; value += step) ticks.push(value)
  return { low, high, ticks }
}

/** Signed percentage; small changes keep two decimals so they don't read as zero. */
export function formatSignedPercent(value: number) {
  const digits = Math.abs(value) < 0.1 ? 2 : 1
  const text = Math.abs(value).toFixed(digits)
  if (!Number.isFinite(value) || Number(text) === 0) return "0%"
  return `${value > 0 ? "+" : "−"}${text}%`
}

/** "+12 (+0.1%)": a change against `base`, the absolute part through `formatValue`. */
export function formatChange(delta: number, base: number, formatValue: (value: number) => string = (value) => Math.round(value).toLocaleString()) {
  const value = Number.isFinite(delta) ? delta : 0
  if (Math.round(value) === 0) return "±0"
  const absolute = `${value > 0 ? "+" : "−"}${formatValue(Math.abs(value))}`
  return base ? `${absolute} (${formatSignedPercent((value / base) * 100)})` : absolute
}

/** Index of the point whose x is closest to `x`; `xs` must be ascending. */
export function nearestIndex(xs: number[], x: number) {
  if (!xs.length) return -1
  let low = 0
  let high = xs.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (xs[mid] < x) low = mid
    else high = mid
  }
  return Math.abs(xs[low] - x) <= Math.abs(xs[high] - x) ? low : high
}

/**
 * Left edge for a floating tooltip beside `anchor`: to the right by default,
 * flipped left when it would cross the edge, and always clamped inside
 * `[margin, bounds - margin]`.
 */
export function tooltipLeft({ anchor, width, bounds, gap = 12, margin = 8 }: { anchor: number; width: number; bounds: number; gap?: number; margin?: number }) {
  const right = anchor + gap
  const flipped = right + width > bounds - margin
  const left = flipped ? anchor - gap - width : right
  const max = Math.max(margin, bounds - margin - width)
  return { left: Math.min(Math.max(left, margin), max), flipped }
}

/** Knots (share of the fall-off) at which the focus gradients set their stops. */
export const FOCUS_KNOTS = [0, 1 / 3, 2 / 3, 1] as const

/**
 * A horizontal CSS gradient mirrored around `var(--fx)` (the focus x, in px).
 * `alphas[i]` is the mask alpha (a number or a CSS calc) at knot i, which sits
 * `clear + (reach - clear) * knot` px from the focus; beyond `reach` the last
 * alpha holds.
 */
export function focusGradient(alphas: readonly (number | string)[], { clear, reach }: { clear: number; reach: number }) {
  const stops = FOCUS_KNOTS.map((knot, index) => ({ alpha: alphas[index], distance: Math.round(clear + (reach - clear) * knot) }))
  const color = (alpha: number | string) => `rgb(0 0 0 / ${alpha})`
  const left = [...stops].reverse().map(({ alpha, distance }) => `${color(alpha)} calc(var(--fx) - ${distance}px)`)
  const right = stops.map(({ alpha, distance }) => `${color(alpha)} calc(var(--fx) + ${distance}px)`)
  return `linear-gradient(to right, ${[...left, ...right].join(", ")})`
}

/** Smoothstep easing, 0..1. */
export function ease(t: number) {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
