import { describe, expect, it } from "vitest"

import fixture from "@/lib/core/fixtures/grafana.json"
import {
  formatAge,
  grafanaUrl,
  groupByDashboard,
  labelEvidence,
  looksLikeLogQL,
  UsageIndexBuilder,
  usagesForMetric,
  type GrafanaUsageIndex,
} from "@/lib/core/grafana-usage"
import { summarizeEvidence, type DashboardEvidence } from "@/lib/core/usage-gate"

const BASE = "https://grafana.example.com"

/** What lib/sources/grafana.ts does, without the network. */
function scanFixture(): GrafanaUsageIndex {
  const builder = new UsageIndexBuilder(BASE)
  const libraries = fixture.search.flatMap((hit) => {
    const { dashboard, meta } = fixture.dashboards[hit.uid as keyof typeof fixture.dashboards]
    return builder.addDashboard(dashboard, { url: meta.url, folder: hit.folderTitle })
  })
  for (const ref of libraries) {
    builder.addLibraryPanel(ref, fixture.libraryElements[ref.uid as keyof typeof fixture.libraryElements].result.model)
  }
  builder.addAlertRules(fixture.alertRules)
  return builder.build("2026-09-26T10:00:00.000Z")
}

describe("Grafana usage index", () => {
  const index = scanFixture()

  it("walks rows, collapsed rows, legacy rows and library panels", () => {
    expect(index.stats).toMatchObject({ dashboards: 3, alerts: 2, libraryPanels: 1 })
    // 9 real panels on the API dashboard (rows excluded), 2 on k8s, 2 legacy.
    expect(index.stats.panels).toBe(13)
    expect(index.metrics.go_goroutines?.[0]).toMatchObject({
      kind: "panel",
      title: "Goroutines",
      url: `${BASE}/d/api-overview/api-overview?viewPanel=6`,
      dashboard: { title: "API overview", folder: "Services" },
    })
    expect(index.metrics.go_memstats_heap_inuse_bytes?.[0]).toMatchObject({ title: "Heap in use", url: `${BASE}/d/api-overview/api-overview?viewPanel=8` })
    expect(index.metrics.node_cpu_seconds_total?.[0].dashboard?.title).toBe("Node (legacy)")
    expect(index.metrics.scrape_duration_seconds).toHaveLength(1)
  })

  it("skips Loki, SQL and expression queries but reads Prometheus targets of mixed panels", () => {
    expect(Object.keys(index.metrics)).not.toContain("app")
    expect(index.stats.skippedQueries).toBe(4) // Loki target, Loki panel, SQL panel, Loki alert
    const errors = index.metrics.prometheus_http_requests_total.find((usage) => usage.title === "Errors vs logs")
    expect(errors?.labels.pod?.map((use) => use.kind)).toEqual(["without"])
  })

  it("reads template variable queries and Grafana-managed alerts", () => {
    const usages = index.metrics.prometheus_http_requests_total
    expect(usages.map((usage) => `${usage.kind}:${usage.title}`).sort()).toEqual([
      "alert:High 5xx rate",
      "panel:Errors vs logs",
      "panel:Request rate by handler",
      "variable:$handler",
      "variable:$job",
    ])
    const alert = usages.find((usage) => usage.kind === "alert")!
    expect(alert.url).toBe(`${BASE}/alerting/grafana/high-error-rate/view`)
    expect(alert.labels.handler?.[0].text).toBe("by (handler)")
    expect(usages.find((usage) => usage.title === "$job")?.labels.job?.[0].text).toBe("label_values (job)")
  })

  it("counts parse failures and keeps the metrics a token scan found", () => {
    expect(index.stats.parseFailures).toBe(1)
    expect(index.failures[0].where).toBe("API overview › Broken query")
    expect(index.metrics.container_memory_working_set_bytes).toHaveLength(1)
  })

  it("matches pattern usages by regex", () => {
    expect(usagesForMetric(index, "node_network_receive_bytes_total")).toHaveLength(1)
    expect(usagesForMetric(index, "node_network_errors_total")).toHaveLength(0)
    expect(usagesForMetric(null, "up")).toEqual([])
  })

  it("tells used, harmless and merely shown labels apart", () => {
    const usages = usagesForMetric(index, "prometheus_http_requests_total")
    const handler = labelEvidence(usages, "handler")
    // The panel, the $handler variable and the alert; "Errors vs logs" only shows it.
    expect(handler.used.map((usage) => usage.title)).toEqual(["Request rate by handler", "$handler", "High 5xx rate"])
    expect(handler.shown.map((usage) => usage.title)).toEqual(["Errors vs logs"])
    expect(handler.uses[0]).toBe("by (handler)")
    const pod = labelEvidence(usages, "pod")
    expect(pod.used).toHaveLength(0)
    expect(pod.harmless.map((usage) => usage.title)).toEqual(["Errors vs logs"])
    const instance = labelEvidence(usagesForMetric(index, "go_goroutines"), "instance")
    expect(instance.uses).toEqual(["{{instance}}"])
    const version = labelEvidence(usagesForMetric(index, "go_goroutines"), "version")
    expect(version.shown).toHaveLength(1)
  })

  it("groups usages per dashboard with alerts last", () => {
    const groups = groupByDashboard(usagesForMetric(index, "prometheus_http_requests_total"))
    expect(groups.map((group) => group.dashboard?.title ?? "alerts")).toEqual(["API overview", "alerts"])
    expect(groups[0].usages).toHaveLength(4)
  })

  it("builds links under a sub-path", () => {
    expect(grafanaUrl("https://ops.example.com/grafana/", "/grafana/d/x/y")).toBe("https://ops.example.com/grafana/d/x/y")
    expect(grafanaUrl("https://ops.example.com/grafana", "/d/x/y")).toBe("https://ops.example.com/grafana/d/x/y")
    expect(looksLikeLogQL('{app="x"} |= "error"')).toBe(true)
    expect(looksLikeLogQL('sum(rate(http_requests_total{app="x"}[5m]))')).toBe(false)
    expect(formatAge(3 * 3600_000 + 5)).toBe("3 h ago")
  })

  it("feeds label-level evidence into the usage gate", () => {
    const now = new Date("2026-09-26T13:00:00.000Z").getTime()
    const scan = (metric: string): DashboardEvidence => ({
      host: "grafana.example.com",
      scannedAt: index.scannedAt,
      dashboardsScanned: index.stats.dashboards,
      alertsScanned: index.stats.alerts,
      usages: usagesForMetric(index, metric),
    })
    const base = { rules: [], cloud: false, cloudUsage: null }
    const handler = summarizeEvidence({ ...base, dashboards: scan("prometheus_http_requests_total") }, "handler", now)
    expect(handler.used).toBe(true)
    expect(handler.found[0]).toMatch(/^handler is used in 1 panel, 1 dashboard variable and 1 Grafana alert rule \(by \(handler\), handler=~"\$handler", \{\{handler\}\}\): API overview, High 5xx rate\.$/)
    expect(handler.checked[0]).toMatch(/3 dashboards, 2 alert rules, scanned 3 h ago/)
    expect(handler.unchecked.join(" ")).not.toMatch(/Dashboards and ad-hoc/)

    const pod = summarizeEvidence({ ...base, dashboards: scan("prometheus_http_requests_total") }, "pod", now)
    expect(pod.used).toBe(false)
    expect(pod.clear.join(" ")).toMatch(/pod is only aggregated away \(without \(pod\)\)/)

    const shown = summarizeEvidence({ ...base, dashboards: scan("prometheus_http_requests_total") }, "method", now)
    expect(shown.used).toBe(false)
    expect(shown.found[0]).toMatch(/^No dashboard groups or filters by method, but 1 panel plots this metric without aggregating method away/)

    const unused = summarizeEvidence({ ...base, dashboards: scan("prometheus_http_request_duration_seconds_bucket") }, "method", now)
    expect(unused.found).toEqual([])
    expect(unused.clear).toContain("No dashboard or Grafana alert groups or filters by method (1 panel reads this metric).")

    const metric = summarizeEvidence({ ...base, dashboards: scan("go_goroutines") }, undefined, now)
    expect(metric.used).toBe(true)
    expect(metric.badge).toBe("1 panel on 1 dashboard")

    const nowhere = summarizeEvidence({ ...base, dashboards: scan("process_open_fds") }, undefined, now)
    expect(nowhere.used).toBe(false)
    expect(nowhere.clear).toContain("No Grafana dashboard or alert on grafana.example.com reads this metric.")

    const stale = summarizeEvidence({ ...base, dashboards: scan("up") }, undefined, now + 9 * 24 * 3600_000)
    expect(stale.unchecked.join(" ")).toMatch(/scan is 9 days old/)
  })
})
