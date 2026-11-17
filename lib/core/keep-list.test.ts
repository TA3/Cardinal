import { describe, expect, it } from "vitest"

import { renderAlloy } from "@/lib/core/compile/alloy"
import { compileAdaptiveMetrics } from "@/lib/core/compile/adaptive-metrics"
import { planRelabel } from "@/lib/core/compile/plan"
import { renderPrometheus } from "@/lib/core/compile/prometheus"
import { keepListDrops, suggestKeepList } from "@/lib/core/keep-list"
import { parsePrometheusRelabel } from "@/lib/core/parse/prometheus"
import { createRule, isShadowed, mergeRules } from "@/lib/core/rules"
import { computeExpectedSavings, snapshotImpact } from "@/lib/core/savings"
import { fromRuleSet, toRuleSet } from "@/lib/core/share"

const snapshot = {
  totalSeries: 1000,
  capturedAt: "2026-11-17T00:00:00Z",
  metrics: [
    { metric: "node_cpu_seconds_total", seriesCount: 400, percentageOfTotal: 40 },
    { metric: "node_softnet_dropped_total", seriesCount: 300, percentageOfTotal: 30 },
    { metric: "go_gc_duration_seconds", seriesCount: 100, percentageOfTotal: 10 },
    { metric: "http_requests_total", seriesCount: 200, percentageOfTotal: 20 },
  ],
  seriesByMetricJob: {
    node_cpu_seconds_total: { node: 400 },
    node_softnet_dropped_total: { node: 300 },
    go_gc_duration_seconds: { node: 50, api: 50 },
    http_requests_total: { api: 200 },
  },
}

const keep = () => createRule({ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total"], origin: "user" })

describe("keep-lists", () => {
  it("suggests keeping what is used or unknown, and whole histogram families", () => {
    const suggestion = suggestKeepList(
      [
        { metric: "a_bucket", seriesCount: 10 },
        { metric: "a_count", seriesCount: 1 },
        { metric: "b", seriesCount: 5 },
        { metric: "c", seriesCount: 3 },
        { metric: "go_goroutines", seriesCount: 1 },
      ],
      { a_bucket: true, a_count: false, b: false, c: undefined, go_goroutines: false }
    )
    expect(suggestion.keep).toEqual(["a_bucket", "a_count", "c"])
    expect(suggestion.drop.map((item) => item.metric)).toEqual(["b", "go_goroutines"])
    expect(suggestion.savedSeries).toBe(6)
    expect(suggestion.selfMetrics).toBe(1)
  })

  it("counts what the job drops from the snapshot, only for that job", () => {
    expect(keepListDrops(snapshot, "node", ["node_cpu_seconds_total"]).map((item) => item.metric)).toEqual([
      "node_softnet_dropped_total",
      "go_gc_duration_seconds",
    ])
    expect(snapshotImpact(keep(), snapshot)).toMatchObject({ seriesBefore: 750, seriesAfter: 400 })
    expect(computeExpectedSavings([keep()], snapshot, {}).savedSeries).toBe(350)
  })

  it("makes metric rules on the dropped metrics of its job redundant", () => {
    const drop = createRule({ kind: "drop_metric", selector: { metric: "node_softnet_dropped_total", job: "node" }, origin: "user" })
    const kept = createRule({ kind: "drop_labels", selector: { metric: "node_cpu_seconds_total", job: "node" }, labels: ["cpu"], origin: "user" })
    expect(isShadowed(drop, [keep(), drop])).toBe(true)
    expect(isShadowed(kept, [keep(), kept])).toBe(false)
    expect(computeExpectedSavings([keep(), drop], snapshot, {}).savedSeries).toBe(350)
  })

  it("exports as mark, drop the unmarked series of the job, remove the mark; always keeps up and scrape_*", () => {
    const yaml = renderPrometheus(planRelabel([keep()], { mode: "combined" }))
    expect(yaml).toContain("regex: node;(node_cpu_seconds_total|up|scrape_[a-z_]+)")
    expect(yaml).toContain("target_label: __tmp_cardinal_keep_metric")
    expect(yaml).toContain("source_labels: [job, __tmp_cardinal_keep_metric]")
    expect(yaml).toContain("regex: node;")
    expect(renderAlloy(planRelabel([keep()], { mode: "combined" }))).toContain('"__tmp_cardinal_keep_metric"')
  })

  it("reads its own export and a plain keep in a scrape config back as keep-lists", () => {
    const back = parsePrometheusRelabel(renderPrometheus(planRelabel([keep()], { mode: "combined" })))
    expect(back.warnings).toEqual([])
    expect(back.rules).toMatchObject([{ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total"] }])
    const plain = parsePrometheusRelabel(`scrape_configs:
  - job_name: windows
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: windows_cpu_time_total|windows_os_info
        action: keep
`)
    expect(plain.rules).toMatchObject([{ kind: "keep_metrics", selector: { job: "windows" }, metrics: ["windows_cpu_time_total", "windows_os_info"] }])
  })

  it("replaces its list when updated, round-trips through sharing, and is skipped by Adaptive Metrics", () => {
    const wider = createRule({ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total", "node_softnet_dropped_total"], origin: "user" })
    expect(mergeRules([keep()], [wider]).skipped).toHaveLength(1)
    const [shared] = fromRuleSet(JSON.parse(JSON.stringify(toRuleSet([keep()])))).rules
    expect(shared).toMatchObject({ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total"], status: "proposed" })
    expect(compileAdaptiveMetrics([keep()]).warnings[0]).toContain("Keep-list for job node")
  })
})
