import { describe, expect, it } from "vitest"

import { buildCutPlan } from "@/lib/core/cut-plan"
import type { Assessment } from "@/lib/core/decide/risk"
import type { MetricOpportunity } from "@/lib/core/opportunities"
import { createRule } from "@/lib/core/rules"

const snapshot = {
  jobs: [
    { job: "node", seriesCount: 900, percentageOfTotal: 90, metricCount: 4 },
    { job: "api", seriesCount: 100, percentageOfTotal: 10, metricCount: 2 },
  ],
  metrics: [
    { metric: "node_cpu_seconds_total", seriesCount: 500, percentageOfTotal: 50, jobs: ["node"] },
    { metric: "node_softnet_dropped_total", seriesCount: 300, percentageOfTotal: 30, jobs: ["node"] },
    { metric: "go_gc_duration_seconds", seriesCount: 100, percentageOfTotal: 10, jobs: ["node", "api"] },
    { metric: "process_open_fds", seriesCount: 50, percentageOfTotal: 5, jobs: ["node", "api"] },
    { metric: "http_requests_total", seriesCount: 50, percentageOfTotal: 5, jobs: ["api"] },
  ],
  seriesByMetricJob: {
    node_cpu_seconds_total: { node: 500 },
    node_softnet_dropped_total: { node: 300 },
    go_gc_duration_seconds: { node: 60, api: 40 },
    process_open_fds: { node: 40, api: 10 },
    http_requests_total: { api: 50 },
  },
}

const risk: Assessment = { level: "review", confidence: 0.5, why: [] }
const unused = (metric: string): MetricOpportunity & { state: "open"; risk: Assessment } => ({
  id: metric,
  reason: "unused",
  metric,
  savedSeries: 300,
  estimate: false,
  rule: { kind: "drop_metric", metric },
  rationale: "",
  state: "open",
  risk,
})
const used = { node_cpu_seconds_total: true, node_softnet_dropped_total: false, go_gc_duration_seconds: false, process_open_fds: false, http_requests_total: true }

describe("cut plan", () => {
  it("suggests a keep-list per job once rules and dashboards were checked, owning the job's metric drops", () => {
    const jobs = buildCutPlan({ snapshot, used, coverage: { rules: true, dashboards: true }, opportunities: [unused("node_softnet_dropped_total")], rules: [] })
    const node = jobs.find((job) => job.job === "node")!
    expect(node.cuts.map((cut) => cut.kind)).toEqual(["keep_list"])
    expect(node.cuts[0]).toMatchObject({ kind: "keep_list", keep: ["node_cpu_seconds_total"], savedSeries: 400, selfMetrics: 2, risk: { level: "safe" } })
    expect(node.openSavings).toBe(400)
  })

  it("falls back to the exporter's own metrics without dashboards, and keeps unknown metrics", () => {
    const partial = { node_cpu_seconds_total: true }
    const jobs = buildCutPlan({ snapshot, used: partial, coverage: { rules: true, dashboards: false }, opportunities: [], rules: [] })
    const node = jobs.find((job) => job.job === "node")!
    expect(node.cuts).toMatchObject([{ kind: "self_metrics", savedSeries: 100, risk: { level: "review", missing: "dashboards" } }])
  })

  it("marks cuts in the plan, keeps their place, and hides what a whole-metric drop already covers", () => {
    const keep = createRule({ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total", "go_gc_duration_seconds"], origin: "user" })
    const trim = { ...unused("http_requests_total"), id: "trim", reason: "buckets" as const, rule: { kind: "keep_buckets" as const, metric: "http_requests_total", buckets: ["1"] } }
    const drop = { ...unused("http_requests_total"), state: "active" as const }
    const jobs = buildCutPlan({ snapshot, used, coverage: { rules: true, dashboards: true }, opportunities: [drop, trim], rules: [keep] })
    const node = jobs.find((job) => job.job === "node")!
    expect(node.cuts[0]).toMatchObject({ kind: "keep_list", state: "active", keep: ["go_gc_duration_seconds", "node_cpu_seconds_total"], savedSeries: 340 })
    expect(node.openSavings).toBe(0)
    const api = jobs.find((job) => job.job === "api")!
    expect(api.cuts.some((cut) => cut.id === "trim")).toBe(false)
  })

  it("puts cuts on metrics several jobs emit in their own group, last", () => {
    const shared = { ...unused("go_gc_duration_seconds"), reason: "id_like" as const, rule: { kind: "drop_labels" as const, metric: "go_gc_duration_seconds", labels: ["quantile"] } }
    const jobs = buildCutPlan({ snapshot, used: {}, coverage: { rules: false, dashboards: false }, opportunities: [shared], rules: [] })
    expect(jobs[jobs.length - 1]).toMatchObject({ job: null, cuts: [{ kind: "opportunity" }] })
  })
})
