// Small pieces the logs overview, Volume and Patterns pages share.

/** Axis ticks: dates for multi-day ranges, times otherwise. */
export function formatTickFor(days: boolean) {
  return (t: number) =>
    days ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function stepLabel(seconds: number) {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} h`
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} min`
  return `${seconds} s`
}

/** "3 h", "45 min". */
export function formatSpan(seconds: number) {
  if (seconds >= 3600) {
    const hours = seconds / 3600
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`
  }
  return `${Math.max(1, Math.round(seconds / 60))} min`
}

/** Five categorical series colours, validated for colour-blind separation in both themes (see volume chart). */
export const SERIES_COLORS = ["var(--vs-1)", "var(--vs-2)", "var(--vs-3)", "var(--vs-4)", "var(--vs-5)"] as const

/** Put on a wrapper so SERIES_COLORS resolve, with dark-mode steps. */
export const SERIES_COLOR_VARS =
  "[--vs-1:#eb6834] [--vs-2:#2a78d6] [--vs-3:#1baf7a] [--vs-4:#eda100] [--vs-5:#e87ba4] dark:[--vs-1:#d95926] dark:[--vs-2:#3987e5] dark:[--vs-3:#199e70] dark:[--vs-4:#c98500] dark:[--vs-5:#d55181]"
