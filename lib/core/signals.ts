// Cardinal covers more than one telemetry signal. Each signal owns a route
// prefix (/metrics, /logs); shared pages (/rules, /attribution, /agent,
// /settings) sit outside them and follow the last signal you used.

export type Signal = "metrics" | "logs"

export const SIGNALS: readonly Signal[] = ["metrics", "logs"]

export const SIGNAL_LABEL: Record<Signal, string> = { metrics: "Metrics", logs: "Logs" }

export function isSignal(value: unknown): value is Signal {
  return SIGNALS.includes(value as Signal)
}

/** The signal a path belongs to, or null for shared pages. */
export function signalFromPath(pathname: string): Signal | null {
  for (const signal of SIGNALS) {
    if (pathname === `/${signal}` || pathname.startsWith(`/${signal}/`)) return signal
  }
  return null
}

/** A signal's overview. */
export function signalHome(signal: Signal) {
  return `/${signal}`
}

/** Where switching to `signal` lands: its last visited page when that still belongs to it, else its overview. */
export function signalEntry(signal: Signal, lastPathBySignal: Partial<Record<Signal, string>>) {
  const last = lastPathBySignal[signal]
  return last && signalFromPath(last.split(/[?#]/)[0]) === signal ? last : signalHome(signal)
}

/** Static sections under /metrics; any other single segment there is a pre-restructure metric link. */
export const METRICS_SECTIONS = ["explore", "jobs", "churn", "histograms"] as const

function withParam(search: string, key: string, value: string) {
  const params = new URLSearchParams(search)
  params.set(key, value)
  return `?${params}`
}

/**
 * The current URL for a pre-restructure one, or null when `pathname` isn't a
 * legacy route. Paths stay URL-encoded and the query string is kept.
 */
export function legacyRedirect(pathname: string, search: string, signal: Signal): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  if (path === "/") return `${signalHome(signal)}${search}`
  if (/^\/(jobs|churn|histograms)(\/|$)/.test(path)) return `/metrics${path}${search}`
  if (path === "/adaptive") return `/rules${withParam(search, "view", "recommendations")}`
  if (path === "/teams") return `/attribution${search}`
  const metric = /^\/metrics\/([^/]+)$/.exec(path)
  if (metric && !(METRICS_SECTIONS as readonly string[]).includes(metric[1])) return `/metrics/explore/${metric[1]}${search}`
  return null
}
