import { jobLabel } from "@/lib/core/jobs"
import { labelDropRule, metricDropRule, useAppStore } from "@/lib/store/app-store"

/** Where a new drop applies when made from a job's context. */
export type DropScope = "job" | "all"

/** Human text for a rule scope: `undefined` is every job, "" the series without a job. */
export function scopeText(job: string | undefined) {
  return job === undefined ? "all jobs" : `job ${jobLabel(job)}`
}

/** The job a new rule gets: the context's job for "job" scope, none (all jobs) otherwise. */
export function targetJob(job: string | undefined, scope: DropScope) {
  return scope === "job" ? job : undefined
}

/**
 * Toggles a metric drop from a view. An existing rule that applies here (the
 * job's own, then the global one) is removed; otherwise one is added for the
 * chosen scope.
 */
export function toggleMetricDrop(metric: string, job: string | undefined, scope: DropScope) {
  const { rules, toggleDropMetric } = useAppStore.getState()
  const existing = metricDropRule(rules, metric, job)
  toggleDropMetric(metric, existing ? existing.selector.job : targetJob(job, scope))
}

export function toggleLabelDrop(metric: string, label: string, job: string | undefined, scope: DropScope) {
  const { rules, toggleDropLabel } = useAppStore.getState()
  const existing = labelDropRule(rules, metric, label, job)
  toggleDropLabel(metric, label, existing ? existing.selector.job : targetJob(job, scope))
}

export function dropHint(kind: "metric" | "label", dropJob: string | undefined | null, target: string | undefined) {
  const what = kind === "metric" ? "this metric" : "this label"
  return dropJob !== null
    ? `Dropped for ${scopeText(dropJob)}. Click to remove the rule.`
    : `Add a rule dropping ${what} for ${scopeText(target)}`
}

// Drops confirmed through the usage gate, so toggling the same drop again
// doesn't ask twice. Per browser; a convenience, not a record.
const CONFIRMED_KEY = "cardinal.drop-confirmed.v1"
const MAX_CONFIRMED = 500

function readConfirmed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CONFIRMED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

export function isDropConfirmed(key: string) {
  return readConfirmed().includes(key)
}

export function rememberDropConfirmed(...keys: string[]) {
  try {
    const next = Array.from(new Set([...keys, ...readConfirmed()])).slice(0, MAX_CONFIRMED)
    localStorage.setItem(CONFIRMED_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the gate just asks again next time.
  }
}
