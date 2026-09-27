import { familyMembers, histogramFamily } from "@/lib/core/families"
import {
  describeUsageCounts,
  formatAge,
  groupByDashboard,
  labelEvidence,
  STALE_SCAN_MS,
  type DashboardUsage,
} from "@/lib/core/grafana-usage"
import type { SnapshotResponse } from "@/lib/prometheus/types"

// The checks shown before a drop becomes active: where the metric is used,
// what wasn't checked, labels that must not be dropped casually, and
// histogram parts a drop would orphan.

/** Labels whose removal breaks things beyond the metric itself. */
export const GUARDED_LABELS: Record<string, { title: string; reason: string }> = {
  le: {
    title: "le holds the histogram buckets",
    reason:
      "Dropping le merges every bucket into one series, so histogram_quantile and heatmaps stop working. To cut bucket series, keep only the buckets you query instead.",
  },
  job: {
    title: "job tells scrape jobs apart",
    reason:
      "Dashboards, alerts and up{} checks filter on job, and without it series from different jobs merge into one.",
  },
  instance: {
    title: "instance tells targets apart",
    reason:
      "Without instance, series from different targets merge, and per-target alerts such as up == 0 stop pointing at anything.",
  },
  __name__: {
    title: "__name__ is the metric name",
    reason: "Removing it leaves nameless series that no query can select.",
  },
}

export function guardedLabel(label: string | undefined) {
  return label === undefined ? undefined : GUARDED_LABELS[label]
}

export interface RuleReference {
  group: string
  name: string
  type: "alerting" | "recording"
}

/** Grafana Cloud usage counts (from Adaptive Metrics recommendations, verbose). */
export interface CloudUsage {
  dashboards: number
  queries: number
  rules: number
  /** Labels the recommendation keeps (used) and drops (unused), when it names them. */
  keptLabels?: string[]
  droppedLabels?: string[]
}

export interface UsageEvidence {
  /** Prometheus rules referencing the metric; null when the rules API couldn't be read. */
  rules: RuleReference[] | null
  rulesError?: string
  /** Whether the connection is Grafana Cloud, where dashboard and query usage is known. */
  cloud: boolean
  /** Usage counts from Grafana Cloud; null when not Grafana Cloud or it has no data for the metric. */
  cloudUsage: CloudUsage | null
  cloudError?: string
  /** Panels and Grafana alerts from the last Grafana scan; null or absent when there is none. */
  dashboards?: DashboardEvidence | null
}

/** What the last Grafana dashboard scan says about one metric. */
export interface DashboardEvidence {
  host: string
  scannedAt: string
  /** Dashboards and alert rules the scan read, for "checked" lines. */
  dashboardsScanned: number
  alertsScanned: number
  alertsError?: string
  usages: DashboardUsage[]
}

export interface EvidenceSummary {
  /** True when anything references the metric (or, for a label, may use it). */
  used: boolean
  /** One line per piece of evidence found. */
  found: string[]
  /** What wasn't (or couldn't be) checked, in plain words. */
  unchecked: string[]
  /** Checks that came back clean, e.g. "No dashboard groups or filters by pod." */
  clear: string[]
  /** Sources that were checked, with the scan age. */
  checked: string[]
  /** A short label for a table cell, e.g. "2 alerts · 4 dashboards". */
  badge: string | null
}

const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString()} ${count === 1 ? word : many}`

/** Names of the dashboards (and alert rules) behind some usages, for one line of text. */
function usageNames(usages: DashboardUsage[], max = 3) {
  const names = groupByDashboard(usages).flatMap((group) =>
    group.dashboard ? [group.dashboard.title] : group.usages.map((usage) => usage.title)
  )
  return `${names.slice(0, max).join(", ")}${names.length > max ? ", …" : ""}`
}

const verb = (usages: DashboardUsage[], one: string, many: string) => (usages.length === 1 ? one : many)

/** Dashboard and Grafana alert evidence from a scan; returns whether it shows a use. */
function summarizeDashboards(
  scan: DashboardEvidence,
  label: string | undefined,
  now: number,
  out: Pick<EvidenceSummary, "found" | "clear" | "checked" | "unchecked"> & { badge: string[] }
) {
  const age = now - new Date(scan.scannedAt).getTime()
  out.checked.push(
    `Grafana dashboards${scan.alertsError ? "" : " and alerts"} on ${scan.host}: ${plural(scan.dashboardsScanned, "dashboard")}${
      scan.alertsError ? "" : `, ${plural(scan.alertsScanned, "alert rule")}`
    }, scanned ${formatAge(age)}.`
  )
  if (age > STALE_SCAN_MS) out.unchecked.push(`The Grafana scan is ${formatAge(age).replace(" ago", "")} old; re-scan in Settings to see current dashboards.`)
  if (scan.alertsError) out.unchecked.push(`Grafana-managed alert rules couldn't be read (${scan.alertsError}).`)

  const { usages } = scan
  if (!label) {
    if (!usages.length) {
      out.clear.push(`No Grafana dashboard or alert on ${scan.host} reads this metric.`)
      return false
    }
    out.found.push(`Grafana: ${describeUsageCounts(usages)} ${verb(usages, "reads", "read")} this metric (${usageNames(usages)}).`)
    const dashboards = new Set(usages.flatMap((usage) => (usage.dashboard ? [usage.dashboard.url] : []))).size
    const alerts = usages.filter((usage) => usage.kind === "alert").length
    const panels = usages.filter((usage) => usage.kind === "panel").length
    if (panels) out.badge.push(`${plural(panels, "panel")} on ${plural(dashboards, "dashboard")}`)
    if (alerts) out.badge.push(plural(alerts, "Grafana alert"))
    return true
  }

  if (!usages.length) {
    out.clear.push(`No Grafana dashboard or alert on ${scan.host} reads this metric, so none uses ${label}.`)
    return false
  }
  const evidence = labelEvidence(usages, label)
  if (evidence.used.length) {
    const how = evidence.uses.slice(0, 3).join(", ")
    out.found.push(`${label} is used in ${describeUsageCounts(evidence.used)} (${how}): ${usageNames(evidence.used)}.`)
    out.badge.push(`${label} used`)
    return true
  }
  if (evidence.shown.length) {
    out.found.push(
      `No dashboard groups or filters by ${label}, but ${describeUsageCounts(evidence.shown)} ${verb(evidence.shown, "plots", "plot")} this metric without aggregating ${label} away (${usageNames(evidence.shown)}); their series would merge.`
    )
  } else if (evidence.harmless.length) {
    out.clear.push(
      `${label} is only aggregated away (${evidence.harmlessUses.slice(0, 2).join(", ")}) in ${describeUsageCounts(evidence.harmless)}; dropping it doesn't change them.`
    )
  } else {
    out.clear.push(`No dashboard or Grafana alert groups or filters by ${label} (${describeUsageCounts(usages)} ${verb(usages, "reads", "read")} this metric).`)
  }
  return false
}

/**
 * Turns raw usage into what the confirm popover says. For a label drop, rules
 * are matched on the metric only, so they are reported as rules that may use
 * the label; dashboards are checked down to the label.
 */
export function summarizeEvidence(evidence: UsageEvidence, label?: string, now = Date.now()): EvidenceSummary {
  const found: string[] = []
  const unchecked: string[] = []
  const clear: string[] = []
  const checked: string[] = []
  const badge: string[] = []

  if (evidence.rules === null) {
    unchecked.push(`Prometheus alerting and recording rules couldn't be read${evidence.rulesError ? ` (${evidence.rulesError})` : ""}.`)
  } else if (evidence.rules.length) {
    const alerts = evidence.rules.filter((rule) => rule.type === "alerting").length
    const recordings = evidence.rules.length - alerts
    const parts = [alerts ? plural(alerts, "alerting rule") : null, recordings ? plural(recordings, "recording rule") : null].filter(Boolean)
    // The same alert often exists once per severity: name each rule once.
    const unique = Array.from(new Set(evidence.rules.map((rule) => rule.name)))
    const names = unique.slice(0, 3).join(", ")
    found.push(
      label
        ? `${parts.join(" and ")} use this metric (${names}${unique.length > 3 ? ", …" : ""}); check whether they group or filter by ${label}.`
        : `${parts.join(" and ")} reference this metric: ${names}${unique.length > 3 ? ", …" : ""}.`
    )
    if (alerts) badge.push(plural(alerts, "alert"))
    if (recordings) badge.push(plural(recordings, "recording"))
  } else {
    clear.push("No Prometheus alerting or recording rule uses it.")
  }

  const scan = evidence.dashboards ?? null
  const cloud = evidence.cloudUsage
  if (!evidence.cloud) {
    unchecked.push(
      scan
        ? "Ad-hoc queries weren't checked: Cardinal only sees them through a Grafana Cloud connection."
        : "Dashboards and ad-hoc queries weren't checked: scan your Grafana in Settings, or use a Grafana Cloud connection."
    )
  } else if (!cloud) {
    unchecked.push(
      evidence.cloudError
        ? `Grafana Cloud usage couldn't be read (${evidence.cloudError}).`
        : "Grafana Cloud has no usage data for this metric yet."
    )
  } else {
    if (label && cloud.droppedLabels?.includes(label)) {
      found.push(`Adaptive Metrics recommends dropping ${label}: no dashboard, query or rule it tracks uses it.`)
    } else if (label && cloud.keptLabels?.includes(label)) {
      found.push(`Adaptive Metrics keeps ${label}: queries, dashboards or rules use it.`)
      badge.push("label used")
    }
    const parts = [
      cloud.dashboards ? plural(cloud.dashboards, "dashboard") : null,
      cloud.queries ? plural(cloud.queries, "query", "queries") : null,
      cloud.rules ? plural(cloud.rules, "Grafana Cloud rule") : null,
    ].filter((part): part is string => Boolean(part))
    if (parts.length) {
      found.push(`Grafana Cloud sees this metric in ${parts.join(", ")}.`)
      if (cloud.dashboards) badge.push(plural(cloud.dashboards, "dashboard"))
      if (cloud.queries) badge.push(plural(cloud.queries, "query", "queries"))
    } else {
      clear.push("Grafana Cloud sees no dashboard, query or rule using it.")
    }
    if (!scan) unchecked.push("Dashboards outside Grafana Cloud weren't checked.")
  }

  const dashboardUse = scan ? summarizeDashboards(scan, label, now, { found, clear, checked, unchecked, badge }) : false

  const labelUnused = Boolean(label && cloud?.droppedLabels?.includes(label))
  const used =
    dashboardUse ||
    (!labelUnused && (Boolean(evidence.rules?.length) || Boolean(cloud && (cloud.dashboards || cloud.queries || cloud.rules))))
  return { used, found, unchecked, clear, checked, badge: badge.length ? badge.join(" · ") : null }
}

/**
 * Identity of a confirmed drop, so toggling the same drop again doesn't ask
 * twice. Job `undefined` (every job) and `""` (no job) differ.
 */
export function confirmationKey(metric: string, job: string | undefined, label?: string) {
  return JSON.stringify([label === undefined ? "metric" : "label", job ?? null, metric, label ?? null])
}

export interface OrphanWarning {
  /** The histogram's base name. */
  base: string
  /** Parts left behind without their buckets (`_sum`, `_count`). */
  orphans: string[]
  /** Every part of the family in the snapshot, for "drop the whole family". */
  members: string[]
}

/** Dropping `x_bucket` leaves `x_sum` and `x_count` without their histogram; null otherwise. */
export function orphanWarning(metric: string, snapshot: Pick<SnapshotResponse, "metrics"> | null): OrphanWarning | null {
  const { base, part } = histogramFamily(metric)
  if (part !== "bucket") return null
  const members = familyMembers(base, snapshot)
  const orphans = members.filter((member) => member !== metric && member !== base)
  return orphans.length ? { base, orphans, members } : null
}
