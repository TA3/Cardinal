import type { CSSProperties } from "react"

export type CardinalityScaleMode = "risk" | "effectiveness"

type OklchStop = {
  value: number
  lightness: number
  chroma: number
  hue: number
}

const RISK_TEXT_STOPS: OklchStop[] = [
  { value: 0, lightness: 0.54, chroma: 0.19, hue: 150 },
  { value: 4, lightness: 0.56, chroma: 0.19, hue: 144 },
  { value: 8, lightness: 0.58, chroma: 0.19, hue: 140 },
  { value: 10, lightness: 0.6, chroma: 0.18, hue: 136 },
  { value: 15, lightness: 0.65, chroma: 0.18, hue: 126 },
  { value: 20, lightness: 0.69, chroma: 0.19, hue: 118 },
  { value: 25, lightness: 0.72, chroma: 0.19, hue: 112 },
  { value: 32, lightness: 0.76, chroma: 0.19, hue: 102 },
  { value: 38, lightness: 0.79, chroma: 0.19, hue: 96 },
  { value: 45, lightness: 0.81, chroma: 0.18, hue: 92 },
  { value: 55, lightness: 0.8, chroma: 0.19, hue: 78 },
  { value: 62, lightness: 0.78, chroma: 0.2, hue: 68 },
  { value: 70, lightness: 0.73, chroma: 0.21, hue: 58 },
  { value: 78, lightness: 0.71, chroma: 0.22, hue: 48 },
  { value: 86, lightness: 0.69, chroma: 0.23, hue: 40 },
  { value: 93, lightness: 0.66, chroma: 0.24, hue: 34 },
  { value: 100, lightness: 0.64, chroma: 0.25, hue: 28 },
]

const RISK_FILL_STOPS: OklchStop[] = [
  { value: 0, lightness: 0.76, chroma: 0.16, hue: 150 },
  { value: 4, lightness: 0.78, chroma: 0.16, hue: 144 },
  { value: 8, lightness: 0.79, chroma: 0.17, hue: 140 },
  { value: 10, lightness: 0.8, chroma: 0.17, hue: 136 },
  { value: 15, lightness: 0.82, chroma: 0.17, hue: 126 },
  { value: 20, lightness: 0.83, chroma: 0.18, hue: 118 },
  { value: 25, lightness: 0.84, chroma: 0.18, hue: 112 },
  { value: 32, lightness: 0.86, chroma: 0.18, hue: 102 },
  { value: 38, lightness: 0.87, chroma: 0.18, hue: 96 },
  { value: 45, lightness: 0.87, chroma: 0.18, hue: 92 },
  { value: 55, lightness: 0.85, chroma: 0.19, hue: 78 },
  { value: 62, lightness: 0.83, chroma: 0.19, hue: 68 },
  { value: 70, lightness: 0.8, chroma: 0.2, hue: 58 },
  { value: 78, lightness: 0.78, chroma: 0.21, hue: 48 },
  { value: 86, lightness: 0.76, chroma: 0.22, hue: 40 },
  { value: 93, lightness: 0.74, chroma: 0.23, hue: 34 },
  { value: 100, lightness: 0.72, chroma: 0.24, hue: 28 },
]

const CONTRAST_EXPONENT = 0.62

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

function emphasizeValue(value: number) {
  return Math.pow(clampPercent(value) / 100, CONTRAST_EXPONENT) * 100
}

function invertForMode(value: number, mode: CardinalityScaleMode) {
  const normalized = mode === "effectiveness" ? 100 - clampPercent(value) : clampPercent(value)
  return emphasizeValue(normalized)
}

function interpolateStop(value: number, stops: OklchStop[]) {
  const normalized = clampPercent(value)
  const upperIndex = stops.findIndex((stop) => normalized <= stop.value)

  if (upperIndex <= 0) {
    return stops[0]
  }

  if (upperIndex === -1) {
    return stops[stops.length - 1]
  }

  const lower = stops[upperIndex - 1]
  const upper = stops[upperIndex]
  const ratio = (normalized - lower.value) / (upper.value - lower.value)

  return {
    value: normalized,
    lightness: lower.lightness + (upper.lightness - lower.lightness) * ratio,
    chroma: lower.chroma + (upper.chroma - lower.chroma) * ratio,
    hue: lower.hue + (upper.hue - lower.hue) * ratio,
  }
}

function formatOklch(stop: OklchStop) {
  return `oklch(${stop.lightness.toFixed(3)} ${stop.chroma.toFixed(3)} ${stop.hue.toFixed(2)})`
}

export function getScaleColor(
  value: number,
  mode: CardinalityScaleMode = "risk",
  target: "text" | "fill" = "text"
) {
  const normalized = invertForMode(value, mode)
  const stops = target === "fill" ? RISK_FILL_STOPS : RISK_TEXT_STOPS
  return formatOklch(interpolateStop(normalized, stops))
}

export function getScaleTextStyle(
  value: number,
  mode: CardinalityScaleMode = "risk"
): CSSProperties {
  return {
    color: getScaleColor(value, mode, "text"),
  }
}

export function getScaleFillStyle(
  value: number,
  mode: CardinalityScaleMode = "risk"
): CSSProperties {
  return {
    backgroundColor: getScaleColor(value, mode, "fill"),
  }
}