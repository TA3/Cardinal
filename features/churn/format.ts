/** "+12.4%", with two decimals for small values so they don't read as zero. */
export function formatChurnPercent(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return "0%"
  const digits = percent < 0.1 ? 2 : percent < 10 ? 1 : 0
  return `+${percent.toFixed(digits)}%`
}

/** "×2.4", or "gone" when nothing of the pair is active any more. */
export function formatRatio(ratio: number | null) {
  if (ratio === null) return "gone"
  return `×${ratio.toFixed(ratio < 10 ? 2 : 0)}`
}

/** Series created per hour, e.g. "180 / h" or "1.2 / h". */
export function formatCreationRate(perSecond: number) {
  const perHour = perSecond * 3600
  if (perHour >= 100) return `${Math.round(perHour).toLocaleString()} / h`
  return `${perHour.toFixed(perHour < 10 ? 1 : 0)} / h`
}
