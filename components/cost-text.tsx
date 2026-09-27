import { toGB } from "@/lib/core/bytes"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

/** The configured price per 1,000 active series per month, or undefined when unset. */
export function readPricePer1k(settings: unknown): number | undefined {
  const value = (settings as { pricePer1kSeries?: unknown } | null)?.pricePer1kSeries
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Dollars, e.g. "$1,240" or "$3.20"; cents only for small amounts. */
export function formatCost(amount: number) {
  const digits = Math.abs(amount) < 100 ? 2 : 0
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Monthly cost of a series count at the configured price; `cost` is null when no price is set. */
export function useCost() {
  const price = useAppStore((state) => readPricePer1k(state.settings))
  const cost = (series: number) => (price === undefined ? null : (series / 1000) * price)
  return {
    price,
    cost,
    /** "≈ $X/mo", or null without a price. */
    format: (series: number) => {
      const amount = cost(series)
      return amount === null ? null : `≈ ${formatCost(amount)}/mo`
    },
  }
}

/** The configured price per GB of logs ingested, or undefined when unset. */
export function readPricePerGB(settings: unknown): number | undefined {
  const value = (settings as { pricePerGB?: unknown } | null)?.pricePerGB
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Cost of ingesting a byte count at the configured price per GB (1024³ bytes); `cost` is null when no price is set. */
export function useBytesCost() {
  const price = useAppStore((state) => readPricePerGB(state.settings))
  const cost = (bytes: number) => (price === undefined ? null : toGB(bytes) * price)
  return {
    price,
    cost,
    /** "≈ $X", with "/day" or another period when given; null without a price. */
    format: (bytes: number, per?: string) => {
      const amount = cost(bytes)
      return amount === null ? null : `≈ ${formatCost(amount)}${per ? `/${per}` : ""}`
    },
  }
}

type CostTextProps =
  | { series: number; bytes?: undefined; per?: undefined; suffix?: string; className?: string }
  | {
      series?: undefined
      /** Logs bytes ingested; priced per GB. */
      bytes: number
      /** The period `bytes` covers, e.g. "day". */
      per?: string
      suffix?: string
      className?: string
    }

/**
 * "≈ $X/mo" for a series count, or "≈ $X/day" for logs bytes, in muted small
 * text; nothing when that price is not set.
 */
export function CostText(props: CostTextProps) {
  const { suffix, className } = props
  const series = useCost()
  const bytes = useBytesCost()
  const text = props.bytes !== undefined ? bytes.format(props.bytes, props.per) : series.format(props.series)
  if (!text) return null
  return (
    <span className={cn("text-xs text-muted-foreground tabular-nums", className)}>
      {text}
      {suffix ? ` ${suffix}` : null}
    </span>
  )
}
