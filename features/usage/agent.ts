import { ensureGrafanaIndex } from "@/features/usage/grafana-store"
import {
  formatAge,
  groupByDashboard,
  hostOf,
  labelEvidence,
  usagesForMetric,
  type DashboardUsage,
  type GrafanaUsageIndex,
} from "@/lib/core/grafana-usage"

// Agent-facing answers from the last Grafana scan (check_dashboard_usage, and
// the dashboard counts check_usage adds). Compact: they land in an agent's context.

const NO_SCAN =
  "No Grafana dashboard scan in this Cardinal tab. Dashboard usage is unknown: ask the user to add their Grafana in Cardinal → Settings → Grafana dashboards and run Scan dashboards, or say in your proposal that dashboards weren't checked."

function scanInfo(index: GrafanaUsageIndex) {
  return {
    grafana: hostOf(index.baseUrl),
    scanned_at: index.scannedAt,
    scan_age: formatAge(Date.now() - new Date(index.scannedAt).getTime()),
    dashboards_scanned: index.stats.dashboards,
    alert_rules_scanned: index.alertsError ? null : index.stats.alerts,
    ...(index.alertsError ? { alert_rules_error: index.alertsError } : {}),
  }
}

const place = (usage: DashboardUsage) => (usage.dashboard ? `${usage.dashboard.title} › ${usage.title}` : `alert: ${usage.title}`)

/** Dashboard counts for check_usage; null without a scan. */
export async function dashboardUsageCounts(metrics: string[]) {
  const index = await ensureGrafanaIndex()
  if (!index) return null
  return Object.fromEntries(
    metrics.map((metric) => {
      const usages = usagesForMetric(index, metric)
      return [
        metric,
        {
          dashboards: new Set(usages.flatMap((usage) => (usage.dashboard ? [usage.dashboard.url] : []))).size,
          panels: usages.filter((usage) => usage.kind === "panel").length,
          grafana_alerts: usages.filter((usage) => usage.kind === "alert").length,
          scan_age: formatAge(Date.now() - new Date(index.scannedAt).getTime()),
        },
      ]
    })
  )
}

export async function checkDashboardUsage(metric: string, labels: string[] = []) {
  const index = await ensureGrafanaIndex()
  if (!index) throw new Error(NO_SCAN)
  const usages = usagesForMetric(index, metric)
  const groups = groupByDashboard(usages)
  return {
    ...scanInfo(index),
    metric,
    used: usages.length > 0,
    dashboards: groups.slice(0, 20).map((group) => ({
      dashboard: group.dashboard?.title ?? "(Grafana-managed alert rules)",
      url: group.dashboard?.url,
      folder: group.dashboard?.folder,
      uses: group.usages.slice(0, 15).map((usage) => ({
        kind: usage.kind,
        title: usage.title,
        url: usage.url,
        labels_used: Object.fromEntries(Object.entries(usage.labels).map(([label, uses]) => [label, uses.map((use) => use.text)])),
        shows_all_labels_except: usage.flow.all ? usage.flow.except : undefined,
      })),
      more: Math.max(0, group.usages.length - 15),
    })),
    more_dashboards: Math.max(0, groups.length - 20),
    labels: labels.map((label) => {
      const evidence = labelEvidence(usages, label)
      const verdict = evidence.used.length
        ? "used"
        : evidence.shown.length
          ? "shown_unaggregated"
          : evidence.harmless.length
            ? "only_aggregated_away"
            : "not_used"
      return {
        label,
        verdict,
        used_in: evidence.used.length,
        how: evidence.uses.slice(0, 5),
        used_by: evidence.used.slice(0, 5).map(place),
        shown_unaggregated_in: evidence.shown.length,
        aggregated_away_in: evidence.harmless.length,
      }
    }),
    note: "used: dropping the label changes those panels or alerts. shown_unaggregated: no query names the label, but panels plot the metric raw, so its series lines would merge. only_aggregated_away / not_used: dashboards and Grafana alerts don't depend on it.",
  }
}
