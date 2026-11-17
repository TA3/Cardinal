import { describe, expect, it } from "vitest"

import { addJobLabelDrops, buildJobWork, jobLabelPlan, removableJobLabel } from "@/lib/core/job-work"
import { queries } from "@/lib/core/promql"
import { createRule, type DropLabelsRule } from "@/lib/core/rules"

const metrics = [
  { metric: "node_cpu_seconds_total", seriesCount: 500 },
  { metric: "node_softnet_dropped_total", seriesCount: 300 },
  { metric: "go_gc_duration_seconds", seriesCount: 100 },
  { metric: "node_filesystem_size_bytes", seriesCount: 80 },
]
const impact = (seriesBefore: number, seriesAfter: number) => ({ seriesBefore, seriesAfter, exact: true, mergesSeries: seriesAfter < seriesBefore, measuredAt: "2026-11-17T00:00:00Z" })

describe("job work", () => {
  it("marks each metric open, cut, dropped or kept, and sums what the job saves", () => {
    const rules = [
      createRule({ kind: "drop_metric", selector: { metric: "go_gc_duration_seconds", job: "node" }, origin: "user" }),
      createRule({ kind: "drop_labels", selector: { metric: "node_cpu_seconds_total", job: "node" }, labels: ["cpu"], origin: "user", impact: impact(500, 50) }),
      // Another job's rule changes nothing here.
      createRule({ kind: "drop_metric", selector: { metric: "node_softnet_dropped_total", job: "other" }, origin: "user" }),
    ]
    const work = buildJobWork({ job: "node", metrics, rules, kept: ["node_filesystem_size_bytes"] })
    expect(work.metrics.map((item) => item.state)).toEqual(["cut", "open", "dropped", "kept"])
    expect(work.savedSeries).toBe(550)
    expect(work.done).toBe(3)
    expect(work.unmeasured).toBe(false)
  })

  it("counts a rule for every job by the job's share, the keep-list as drops, and flags what isn't measured", () => {
    const rules = [
      createRule({ kind: "keep_metrics", selector: { job: "node" }, metrics: ["node_cpu_seconds_total", "node_filesystem_size_bytes"], origin: "user" }),
      // 1,000 series across jobs, half saved: this job has 500 of them.
      createRule({ kind: "drop_labels", selector: { metric: "node_cpu_seconds_total" }, labels: ["mode"], origin: "user", impact: impact(1000, 500) }),
      createRule({ kind: "drop_labels", selector: { metric: "node_filesystem_size_bytes", job: "node" }, labels: ["device"], origin: "user" }),
    ]
    const work = buildJobWork({ job: "node", metrics, rules, kept: [] })
    const byMetric = Object.fromEntries(work.metrics.map((item) => [item.metric, item]))
    expect(byMetric.node_cpu_seconds_total).toMatchObject({ state: "cut", savedSeries: 250 })
    expect(byMetric.node_softnet_dropped_total).toMatchObject({ state: "dropped", byKeepList: true, savedSeries: 300 })
    expect(byMetric.node_filesystem_size_bytes).toMatchObject({ state: "cut", savedSeries: 0, unmeasured: true })
    expect(work.savedSeries).toBe(650)
    expect(work.unmeasured).toBe(true)
  })

  it("removes a label from a job only where nothing merges, unless told how to merge", () => {
    const rows = [
      { metric: "a_total", seriesBefore: 40, seriesAfter: 40 },
      { metric: "b_total", seriesBefore: 90, seriesAfter: 30 },
    ]
    expect(jobLabelPlan(rows, "skip")).toMatchObject({ targets: [rows[0]], savedSeries: 0 })
    expect(jobLabelPlan(rows, "aggregate")).toMatchObject({ targets: rows, savedSeries: 60 })

    const existing = createRule({ kind: "drop_labels", selector: { metric: "a_total", job: "node" }, labels: ["pod"], origin: "user" })
    const rules = addJobLabelDrops([existing], { job: "node", label: "pod_hash", targets: rows, merge: "aggregate", measuredAt: "2026-11-17T00:00:00Z" })
    expect(rules).toHaveLength(2)
    // Folded into the metric's existing drop for the job; measured again since its labels changed.
    expect(rules[0]).toMatchObject({ id: existing.id, labels: ["pod", "pod_hash"], impact: undefined })
    expect(rules[1] as DropLabelsRule).toMatchObject({ selector: { metric: "b_total", job: "node" }, labels: ["pod_hash"], onMerge: "aggregate", impact: { seriesBefore: 90, seriesAfter: 30, mergesSeries: true } })
  })

  it("never offers labels a whole job needs, and keeps metrics apart when counting without a label", () => {
    expect(["le", "instance", "job", "quantile", "pod_template_hash"].filter(removableJobLabel)).toEqual(["pod_template_hash"])
    expect(queries.jobSeriesWithoutLabel("node", "pod")).toBe(
      'count by (cardinal_metric) (count without (pod) (label_replace({__name__=~".+",job="node",pod!=""}, "cardinal_metric", "$1", "__name__", "(.+)")))'
    )
  })
})
