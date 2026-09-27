import * as React from "react"

import { useGrafanaStore } from "@/features/usage/grafana-store"
import { hostOf, labelEvidence, usagesForMetric, type GrafanaUsageIndex, type LabelEvidence } from "@/lib/core/grafana-usage"
import type { DashboardEvidence } from "@/lib/core/usage-gate"

// Hooks over the last Grafana scan, for the usage gate, the metric page and
// the labels table.

export function dashboardEvidenceFor(index: GrafanaUsageIndex | null, metric: string): DashboardEvidence | null {
  if (!index) return null
  return {
    host: hostOf(index.baseUrl),
    scannedAt: index.scannedAt,
    dashboardsScanned: index.stats.dashboards,
    alertsScanned: index.stats.alerts,
    ...(index.alertsError ? { alertsError: index.alertsError } : {}),
    usages: usagesForMetric(index, metric),
  }
}

/** The last scan of the configured Grafana, and whether it is still being read from the cache. */
export function useGrafanaIndex() {
  const index = useGrafanaStore((state) => state.index)
  const loading = useGrafanaStore((state) => state.indexStatus === "loading")
  return { index, loading }
}

/** Dashboard evidence for one metric; null without a scan. */
export function useDashboardEvidence(metric: string) {
  const { index, loading } = useGrafanaIndex()
  const evidence = React.useMemo(() => dashboardEvidenceFor(index, metric), [index, metric])
  return { evidence, loading }
}

/**
 * Per-label dashboard usage of one metric, for the labels table. `labelUsage`
 * is null without a scan, or when no dashboard reads the metric at all.
 */
export function useLabelDashboardUsage(metric: string) {
  const { evidence } = useDashboardEvidence(metric)
  const labelUsage = React.useCallback(
    (label: string): LabelEvidence | null => (evidence?.usages.length ? labelEvidence(evidence.usages, label) : null),
    [evidence]
  )
  return { evidence, labelUsage }
}

/** The current time, refreshed every minute, for "scanned 3 min ago". */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
