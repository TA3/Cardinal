import { describe, expect, it } from "vitest"

import { renderAlloy } from "@/lib/core/compile/alloy"
import { groupingStatements } from "@/lib/core/compile/alloy-groupings"
import { planRelabel } from "@/lib/core/compile/plan"
import { parseAlloyRelabel } from "@/lib/core/parse/alloy"
import { compileAdaptiveMetrics } from "@/lib/core/compile/adaptive-metrics"
import { renderPrometheus } from "@/lib/core/compile/prometheus"
import { parsePrometheusRelabel } from "@/lib/core/parse/prometheus"
import { fullMatch, regexProblem } from "@/lib/core/regex"
import { createRule, mergeRules } from "@/lib/core/rules"
import { fromRuleSet, toRuleSet } from "@/lib/core/share"
import { groupedExpr, groupOf, groupOutcome, literalValues, suggestGroups, valuesRegex } from "@/lib/core/value-groups"

const status = [
  { value: "200", seriesCount: 50 },
  { value: "204", seriesCount: 10 },
  { value: "404", seriesCount: 5 },
  { value: "500", seriesCount: 3 },
  { value: "503", seriesCount: 2 },
]

const rule = () =>
  createRule({
    kind: "group_values",
    selector: { metric: "http_requests_total" },
    label: "code",
    groups: [
      { name: "2xx", regex: "2\\d\\d" },
      { name: "5xx", regex: "5\\d\\d" },
    ],
    rest: "other",
    aggregation: "sum",
    origin: "user",
  })

describe("value groups", () => {
  it("groups values that hold newlines and tabs, like SQL text", () => {
    const values = ["SELECT\t2", "SELECT 1\n  FROM t"]
    const regex = valuesRegex(values)
    expect(regex).toBe("SELECT\\x092|SELECT 1\\x0A  FROM t")
    expect(regexProblem(regex)).toBeNull()
    expect(values.every((value) => fullMatch(regex, value))).toBe(true)
    expect(literalValues(regex)).toEqual(values)
    const grouped = createRule({
      kind: "group_values",
      selector: { metric: "pg_stat_statements_calls" },
      label: "query",
      groups: [{ name: "pgquery", regex }],
      aggregation: "sum",
      origin: "user",
      impact: { seriesBefore: 2, seriesAfter: 1, exact: true, mergesSeries: false, window: "1h", measuredAt: "" },
    })
    const yaml = renderPrometheus(planRelabel([grouped], { mode: "combined" }))
    expect(yaml).toContain("x0A")
  })

  it("puts a value in the first matching group, the rest only when it has a value", () => {
    const groups = [
      { name: "a", regex: "20." },
      { name: "b", regex: "2.." },
    ]
    expect(groupOf("204", groups)).toBe(0)
    expect(groupOf("250", groups)).toBe(1)
    expect(groupOf("404", groups)).toBeNull()
    expect(groupOf("404", groups, "other")).toBe(-1)
    expect(groupOf("", groups, "other")).toBeNull()
  })

  it("summarises the outcome by output value", () => {
    const outcome = groupOutcome(status, [{ name: "2xx", regex: "2\\d\\d" }], "other")
    expect(outcome.map((row) => [row.name, row.seriesCount, row.values.length])).toEqual([
      ["2xx", 60, 2],
      ["other", 10, 3],
    ])
  })

  it("reads a literal alternation back as values, and refuses real patterns", () => {
    expect(literalValues(valuesRegex(["a.b", "c"]))).toEqual(["a.b", "c"])
    expect(literalValues("2\\d\\d")).toBeNull()
    expect(literalValues("a|.*")).toBeNull()
  })

  it("builds PromQL where the first group wins and dollars stay literal", () => {
    const expr = groupedExpr('{__name__="m"}', {
      label: "code",
      groups: [
        { name: "2xx", regex: "2.." },
        { name: "$x", regex: "20." },
      ],
      rest: "other",
      aggregation: "max",
    })
    expect(expr).toBe(
      'max without (cardinal_group) (label_replace(label_replace(label_replace(label_replace({__name__="m"}, "cardinal_group", "other", "code", ".+"), "cardinal_group", "$$x", "code", "(?:20.)"), "cardinal_group", "2xx", "code", "(?:2..)"), "code", "$1", "cardinal_group", "(.+)"))'
    )
  })

  it("suggests status classes, routes, workloads and top-N", () => {
    expect(suggestGroups(status).find((item) => item.id === "status")?.groups.map((group) => group.name)).toEqual(["2xx", "4xx", "5xx"])
    const routes = suggestGroups([
      { value: "/api/users/123", seriesCount: 1 },
      { value: "/api/users/456", seriesCount: 1 },
      { value: "/health", seriesCount: 1 },
    ])
    expect(routes.find((item) => item.id === "routes")?.groups).toEqual([{ name: "/api/users/:id", regex: "/api/users/[^/]+" }])
    const pods = suggestGroups([
      { value: "api-7d9f8b6c4-xk2p9", seriesCount: 1 },
      { value: "api-7d9f8b6c4-ab3c1", seriesCount: 1 },
      { value: "web-0", seriesCount: 1 },
    ])
    expect(pods.find((item) => item.id === "workloads")?.groups.map((group) => group.name)).toEqual(["api"])
    const many = Array.from({ length: 12 }, (_, index) => ({ value: `v${index}`, seriesCount: 12 - index }))
    expect(suggestGroups(many).find((item) => item.id === "top")?.rest).toBe("other")
  })
})

describe("group_values rules", () => {
  it("ships as a recording rule on remote write and is held back at scrape time", () => {
    const remote = planRelabel([rule()], { mode: "combined", aggregate: true })
    expect(remote.held).toEqual([])
    const yaml = renderPrometheus(remote, "remote_write")
    expect(yaml).toContain("record: http_requests_total:sum_grouped_code")
    expect(yaml).toContain("sum without (cardinal_group)")
    const scrape = planRelabel([rule()], { mode: "combined" })
    expect(scrape.held).toHaveLength(1)
    expect(scrape.sections.every((section) => section.steps.length === 0)).toBe(true)
  })

  it("is skipped by Adaptive Metrics with a warning", () => {
    const result = compileAdaptiveMetrics([rule()])
    expect(result.rules).toEqual([])
    expect(result.warnings[0]).toContain("grouping code")
  })

  it("round-trips through a shared rule set", () => {
    const [back] = fromRuleSet(JSON.parse(JSON.stringify(toRuleSet([rule()])))).rules
    expect(back).toMatchObject({ kind: "group_values", label: "code", rest: "other", aggregation: "sum", status: "proposed" })
  })

  it("skips an identical grouping but keeps a different one apart", () => {
    const first = rule()
    expect(mergeRules([first], [rule()]).skipped).toHaveLength(1)
  })
})

describe("group_values in Alloy", () => {
  it("folds values in OpenTelemetry and merges per output value, first group winning", () => {
    const { datapoint, metric } = groupingStatements([
      { metric: "http_requests_total", job: "api", grouping: { label: "code", groups: [{ name: "2xx", regex: "2\\d\\d" }], rest: "other", aggregation: "avg" } },
    ])
    expect(datapoint[0]).toBe(
      'set(attributes["cardinal_group"], "2xx") where (metric.name == "http_requests_total" or metric.name == "http_requests") and resource.attributes["service.name"] == "api" and attributes["cardinal_group"] == nil and attributes["code"] != nil and IsMatch(attributes["code"], "^(?:2\\\\d\\\\d)$")'
    )
    expect(datapoint[1]).toContain('set(attributes["cardinal_group"], "other")')
    expect(datapoint[2]).toContain('set(attributes["code"], attributes["cardinal_group"])')
    expect(metric).toHaveLength(2)
    expect(metric[0]).toContain('aggregate_on_attribute_value("mean", "code", ["2xx"], "2xx")')
  })

  it("splits the grouped metric off to the transform and still reads back the other rules", () => {
    const drop = createRule({ kind: "drop_metric", selector: { metric: "unused_total" }, origin: "user" })
    const plan = planRelabel([rule(), drop], { mode: "combined", otel: true })
    expect(plan.held).toEqual([])
    const alloy = renderAlloy(plan)
    expect(alloy).toContain("forward_to = [prometheus.relabel.cardinal_ungrouped.receiver, prometheus.relabel.cardinal_grouping.receiver]")
    expect(alloy).toContain('otelcol.processor.transform "cardinal_grouping"')
    expect(alloy).toContain('regex         = "http_requests_total;.*"')
    const back = parseAlloyRelabel(alloy)
    expect(back.rules.map((item) => item.kind)).toContain("drop_metric")
    expect(back.rules.some((item) => item.selector.metric === "http_requests_total")).toBe(false)
  })

  it("renders groupings even with no relabel rules", () => {
    const alloy = renderAlloy(planRelabel([rule()], { mode: "combined", otel: true }))
    expect(alloy).toContain('prometheus.relabel "cardinal"')
    expect(alloy).toContain("aggregate_on_attribute_value")
  })
})

describe("group_values as plain relabel rules", () => {
  const safe = () => ({ ...rule(), impact: { seriesBefore: 40, seriesAfter: 4, exact: true, mergesSeries: false, window: "1h", measuredAt: "" } })

  it("rewrites values in every relabel export when nothing collides", () => {
    const plan = planRelabel([safe()], { mode: "combined" })
    expect(plan.held).toEqual([])
    const yaml = renderPrometheus(plan)
    expect(yaml).toContain("target_label: __tmp_cardinal_group")
    expect(yaml).toContain('regex: http_requests_total;(.+)')
    expect(yaml).toContain("labeldrop")
    // Rest first, then groups last to first, so the first group wins.
    expect(yaml.indexOf("replacement: other")).toBeLessThan(yaml.indexOf("replacement: 5xx"))
    expect(yaml.indexOf("replacement: 5xx")).toBeLessThan(yaml.indexOf("replacement: 2xx"))
    expect(renderAlloy(planRelabel([safe()], { mode: "combined", otel: true }))).not.toContain("otelcol")
  })

  it("reads the relabel rules back as the same grouping", () => {
    const back = parsePrometheusRelabel(renderPrometheus(planRelabel([safe()], { mode: "combined" })))
    expect(back.warnings).toEqual([])
    expect(back.rules[0]).toMatchObject({
      kind: "group_values",
      label: "code",
      groups: [
        { name: "2xx", regex: "2\\d\\d" },
        { name: "5xx", regex: "5\\d\\d" },
      ],
      rest: "other",
      relabel: true,
    })
  })

  it("keeps a merging grouping off the scrape config", () => {
    const merging = { ...rule(), impact: { seriesBefore: 40, seriesAfter: 4, exact: true, mergesSeries: true, measuredAt: "" } }
    expect(planRelabel([merging], { mode: "combined" }).held).toHaveLength(1)
  })
})
