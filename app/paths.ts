import { jobToParam } from "@/lib/core/jobs"

// Route paths. Metrics pages live under /metrics, logs pages under /logs, and
// shared pages (rules, attribution, agent, settings) at the top level. Job
// names may contain "/", so the job route is a splat and each segment is
// encoded on its own.

export const paths = {
  overview: "/metrics",
  explore: "/metrics/explore",
  jobs: "/metrics/jobs",
  churn: "/metrics/churn",
  histograms: "/metrics/histograms",
  logs: "/logs",
  logStreams: "/logs/streams",
  logLabels: "/logs/labels",
  logVolume: "/logs/volume",
  logPatterns: "/logs/patterns",
  rules: "/rules",
  recommendations: "/rules?view=recommendations",
  attribution: "/attribution",
  agent: "/agent",
  settings: "/settings",
} as const

export function jobPath(job: string) {
  return `${paths.jobs}/${jobToParam(job).split("/").map(encodeURIComponent).join("/")}`
}

export function metricPath(metric: string) {
  return `${paths.explore}/${encodeURIComponent(metric)}`
}

/** The metrics list filtered to metrics carrying `label`. */
export function labelPath(label: string) {
  return `${paths.explore}?label=${encodeURIComponent(label)}`
}

/** Rules, on a status tab. */
export function rulesPath(tab: "active" | "proposed" | "rejected") {
  return `${paths.rules}?tab=${tab}`
}

/** A logs group's detail page (a service, by the snapshot's group label). One encoded segment, so values may contain "/". */
export function logGroupPath(group: string) {
  return `${paths.logStreams}/${encodeURIComponent(group)}`
}

/** The logs labels page, focused on `label`. */
export function logLabelPath(label: string) {
  return `${paths.logLabels}?label=${encodeURIComponent(label)}`
}
