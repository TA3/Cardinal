"use client"

import {
  DropRuleMode,
  JobDrilldownResponse,
  MetricDrilldown,
  SnapshotResponse,
} from "@/lib/prometheus/types"

const STORAGE_KEY = "cardinal.dashboard.session"

export interface StoredDashboardSession {
  baseUrl: string
  instanceId: string
  token: string
  rememberConnection: boolean
  proxyMode: boolean
  topN: number
  connectionExpanded: boolean
  snapshot: SnapshotResponse | null
  selectedJob: string | null
  jobDrilldown: JobDrilldownResponse | null
  selectedMetric: string | null
  metricDrilldown: MetricDrilldown | null
  activePanel: "job" | "metric" | null
  filterByJob: string | null
  showMetricInLeftPane: boolean
  dropMetrics: string[]
  selectedLabelsByMetric: Record<string, string[]>
  expandedMetricPreviews: string[]
  metricPreviewCache: Record<string, MetricDrilldown>
  metricPreviewErrors: Record<string, string>
  activityLog: string[]
  dropRuleMode: DropRuleMode
  viewMode: "table" | "flow"
  topMetricsPerJobInFlow: number
}

export function getStoredDashboardSession(): StoredDashboardSession | null {
  if (typeof window === "undefined") {
    return null
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as StoredDashboardSession
    if (!parsed || typeof parsed !== "object") {
      return null
    }

    return {
      baseUrl: parsed.baseUrl ?? "",
      instanceId: parsed.instanceId ?? "",
      token: parsed.token ?? "",
      rememberConnection: parsed.rememberConnection ?? false,
      proxyMode: parsed.proxyMode ?? false,
      topN: parsed.topN ?? 20,
      connectionExpanded: parsed.connectionExpanded ?? true,
      snapshot: parsed.snapshot ?? null,
      selectedJob: parsed.selectedJob ?? null,
      jobDrilldown: parsed.jobDrilldown ?? null,
      selectedMetric: parsed.selectedMetric ?? null,
      metricDrilldown: parsed.metricDrilldown ?? null,
      activePanel: parsed.activePanel ?? null,
      filterByJob: parsed.filterByJob ?? null,
      showMetricInLeftPane: parsed.showMetricInLeftPane ?? false,
      dropMetrics: parsed.dropMetrics ?? [],
      selectedLabelsByMetric: parsed.selectedLabelsByMetric ?? {},
      expandedMetricPreviews: parsed.expandedMetricPreviews ?? [],
      metricPreviewCache: parsed.metricPreviewCache ?? {},
      metricPreviewErrors: parsed.metricPreviewErrors ?? {},
      activityLog: parsed.activityLog ?? [],
      dropRuleMode: parsed.dropRuleMode ?? "combined",
      viewMode: parsed.viewMode ?? "table",
      topMetricsPerJobInFlow: parsed.topMetricsPerJobInFlow ?? 10,
    }
  } catch {
    return null
  }
}

export function saveStoredDashboardSession(session: StoredDashboardSession) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredDashboardSession() {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.removeItem(STORAGE_KEY)
}
