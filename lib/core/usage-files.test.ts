import { describe, expect, it } from "vitest"

import fixture from "@/lib/core/fixtures/grafana.json"
import { usagesForMetric } from "@/lib/core/grafana-usage"
import { buildUsageIndexFromFiles, UPLOADED_USAGE_KEY } from "@/lib/core/usage-files"

const apiOverview = fixture.dashboards["api-overview"]

describe("usage index from uploaded files", () => {
  it("reads a dashboard as Grafana's API returns it, with links when the Grafana URL is known", () => {
    const index = buildUsageIndexFromFiles([{ name: "api.json", text: JSON.stringify(apiOverview) }], "https://grafana.example.com/")
    expect(index.source).toBe("files")
    expect(index.baseUrl).toBe("https://grafana.example.com")
    expect(index.stats.dashboards).toBe(1)
    // Its library panel's model isn't in the file.
    expect(index.problems.map((problem) => problem.where)).toEqual(["Library panel Heap in use"])
    const [metric] = Object.keys(index.metrics)
    expect(index.metrics[metric][0].url).toMatch(/^https:\/\/grafana\.example\.com\/d\/api-overview/)
  })

  it("reads library panels inlined by \"Export for sharing externally\"", () => {
    const exported = { ...apiOverview.dashboard, __elements: { "lib-heap": fixture.libraryElements["lib-heap"].result } }
    const index = buildUsageIndexFromFiles([{ name: "api.json", text: JSON.stringify(exported) }])
    expect(index.problems).toEqual([])
    expect(usagesForMetric(index, "go_memstats_heap_inuse_bytes")[0]).toMatchObject({ kind: "panel", title: "Heap in use" })
  })

  it("reads a bare dashboard model without a Grafana URL", () => {
    const index = buildUsageIndexFromFiles([{ name: "api.json", text: JSON.stringify(apiOverview.dashboard) }])
    expect(index.baseUrl).toBe(UPLOADED_USAGE_KEY)
    expect(index.stats.dashboards).toBe(1)
    expect(Object.keys(index.metrics).length).toBeGreaterThan(0)
  })

  it("reads Prometheus rule files and PrometheusRule resources", () => {
    const rules = `groups:
  - name: api
    rules:
      - alert: HighErrors
        expr: sum(rate(http_requests_total{code=~"5.."}[5m])) by (service) > 1
      - record: job:latency:p99
        expr: histogram_quantile(0.99, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))
`
    const crd = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    - name: nodes
      rules:
        - alert: DiskFull
          expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.05
`
    const index = buildUsageIndexFromFiles([
      { name: "rules.yaml", text: rules },
      { name: "nodes.yml", text: crd },
    ])
    expect(index.problems).toEqual([])
    expect(index.rulesIncluded).toBe(true)
    expect(index.stats.alerts).toBe(2)
    expect(usagesForMetric(index, "http_requests_total")[0]).toMatchObject({ kind: "alert", title: "api / HighErrors" })
    expect(usagesForMetric(index, "http_request_duration_seconds_bucket")[0].labels.job).toBeDefined()
    expect(usagesForMetric(index, "node_filesystem_size_bytes")).toHaveLength(1)
  })

  it("reads Grafana alert rule exports", () => {
    const exported = {
      apiVersion: 1,
      groups: [{ name: "g", rules: [{ uid: "r1", title: "Queue backlog", data: [{ refId: "A", model: { expr: "sum(queue_depth) > 100" } }] }] }],
    }
    const index = buildUsageIndexFromFiles([{ name: "alerts.json", text: JSON.stringify(exported) }])
    expect(usagesForMetric(index, "queue_depth")[0]).toMatchObject({ kind: "alert", title: "Queue backlog" })
  })

  it("reports files it can't use instead of failing", () => {
    const index = buildUsageIndexFromFiles([
      { name: "broken.json", text: "{ nope" },
      { name: "other.yaml", text: "foo: bar" },
    ])
    expect(index.problems.map((problem) => problem.where)).toEqual(["broken.json", "other.yaml"])
    expect(index.stats.dashboards).toBe(0)
  })
})
