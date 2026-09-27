import { describe, expect, it } from "vitest"

import { createRule } from "@/lib/core/rules"
import { buildSnapshotFromRows } from "@/lib/core/snapshot"
import {
  UNATTRIBUTED_ID,
  assignOwnership,
  jobOwners,
  labelRuleKey,
  ownershipRuleProblem,
  parseOwners,
  parseOwnersJson,
  parseOwnersText,
  previewOwnershipRule,
  queryableLabelRules,
  suggestOwners,
  ownerRuleQueries,
  ruleOwnerSavings,
  ownerSnapshot,
  ownersToJson,
  ownersToText,
  type Owner,
} from "@/lib/core/owner-rules"

const snapshot = buildSnapshotFromRows(
  [
    { job: "payments-api", metric: "http_requests_total", seriesCount: 400 },
    { job: "payments-api", metric: "payments_charges_total", seriesCount: 100 },
    { job: "search", metric: "http_requests_total", seriesCount: 300 },
    { job: "search", metric: "search_queries_total", seriesCount: 50 },
    { job: "node", metric: "node_cpu_seconds_total", seriesCount: 150 },
  ],
  null,
  20
)

const team = (id: string, rules: Owner["rules"]): Owner => ({ id, name: id, rules })

describe("team ownership", () => {
  it("assigns job and metric-prefix rules exactly, first match wins", () => {
    const teams = [
      team("payments", [{ kind: "job", pattern: "payments-.*" }]),
      // Would also match payments-api's metric, but payments came first.
      team("search", [{ kind: "metric_prefix", pattern: "payments_|search_" }, { kind: "job", pattern: "search" }]),
    ]
    const ownership = assignOwnership(snapshot, teams)
    expect(ownership.owners.map((item) => item.series)).toEqual([500, 350])
    expect(ownership.unattributed.series).toBe(150)
    expect(ownership.unattributed.id).toBe(UNATTRIBUTED_ID)
    expect(ownership.owners[0].metrics).toEqual([
      { metric: "http_requests_total", series: 400 },
      { metric: "payments_charges_total", series: 100 },
    ])
    expect(ownership.owners[0].percent).toBe(50)
    expect(ownership.approximate).toBe(false)
    expect(ownership.owners.reduce((sum, item) => sum + item.series, ownership.unattributed.series)).toBe(snapshot.totalSeries)
  })

  it("anchors job patterns fully and metric prefixes at the start", () => {
    const ownership = assignOwnership(snapshot, [team("a", [{ kind: "job", pattern: "payments" }, { kind: "metric_prefix", pattern: "cpu" }])])
    expect(ownership.owners[0].series).toBe(0)
  })

  it("ignores invalid rules", () => {
    expect(ownershipRuleProblem({ kind: "job", pattern: "(a" })).toMatch(/pattern/)
    expect(ownershipRuleProblem({ kind: "label", label: "1x", pattern: "a" })).toMatch(/label/)
    expect(ownershipRuleProblem({ kind: "label", label: "__name__", pattern: "a" })).toMatch(/metric prefix/)
    expect(ownershipRuleProblem({ kind: "label", label: "namespace", pattern: "payments-.*" })).toBeNull()
    const ownership = assignOwnership(snapshot, [team("a", [{ kind: "job", pattern: "(?=x)" }])])
    expect(ownership.owners[0].series).toBe(0)
  })

  it("merges label rule rows per cell, capped by what earlier rules left", () => {
    const rule = { kind: "label" as const, label: "namespace", pattern: "payments-.*" }
    const teams = [team("search", [{ kind: "job", pattern: "search" }]), team("payments", [rule])]
    const pending = assignOwnership(snapshot, teams)
    expect(pending.pendingLabelRules).toEqual([labelRuleKey(rule)])
    expect(pending.owners[1].series).toBe(0)

    const ownership = assignOwnership(snapshot, teams, {
      [labelRuleKey(rule)]: [
        { job: "payments-api", metric: "http_requests_total", seriesCount: 250 },
        // Already owned by search: the label rule gets nothing here.
        { job: "search", metric: "http_requests_total", seriesCount: 300 },
      ],
    })
    expect(ownership.pendingLabelRules).toEqual([])
    expect(ownership.owners[1].series).toBe(250)
    expect(ownership.unattributed.series).toBe(1000 - 350 - 250)
  })

  it("flags cells matched by two label rules as approximate", () => {
    const a = { kind: "label" as const, label: "team", pattern: "a" }
    const b = { kind: "label" as const, label: "namespace", pattern: "b" }
    const ownership = assignOwnership(snapshot, [team("a", [a]), team("b", [b])], {
      [labelRuleKey(a)]: [{ job: "node", metric: "node_cpu_seconds_total", seriesCount: 100 }],
      [labelRuleKey(b)]: [{ job: "node", metric: "node_cpu_seconds_total", seriesCount: 100 }],
    })
    expect(ownership.approximate).toBe(true)
    expect(ownership.owners.map((item) => item.series)).toEqual([100, 50])
  })

  it("lists job owners, largest first", () => {
    const rule = { kind: "label" as const, label: "namespace", pattern: "x" }
    const ownership = assignOwnership(snapshot, [team("x", [rule])], {
      [labelRuleKey(rule)]: [{ job: "search", metric: "http_requests_total", seriesCount: 300 }],
    })
    const owners = jobOwners(ownership).get("search")!
    expect(owners.map((owner) => [owner.id, owner.series])).toEqual([
      ["x", 300],
      [UNATTRIBUTED_ID, 50],
    ])
  })

  it("previews what a rule matches", () => {
    expect(previewOwnershipRule(snapshot, { kind: "job", pattern: "payments-.*|node" })).toEqual({
      names: [
        { name: "payments-api", series: 500 },
        { name: "node", series: 150 },
      ],
      series: 650,
    })
    expect(previewOwnershipRule(snapshot, { kind: "metric_prefix", pattern: "http_" })?.series).toBe(700)
    expect(previewOwnershipRule(snapshot, { kind: "label", label: "a", pattern: "b" })).toBeNull()
  })

  it("dedupes label rules for queries and builds safe PromQL", () => {
    const rule = { kind: "label" as const, label: "namespace", pattern: 'a"b' }
    expect(queryableLabelRules([team("a", [rule]), team("b", [rule, { kind: "label", label: "bad-name", pattern: "x" }])])).toHaveLength(1)
    expect(ownerRuleQueries.seriesMatchingLabel("namespace", 'a"b')).toBe('count by (job, __name__) ({__name__=~".+",namespace=~"a\\"b"})')
    expect(ownerRuleQueries.seriesByLabelValue("namespace", 10000)).toBe('topk(200, count by (namespace) ({__name__=~".+"}))')
    expect(() => ownerRuleQueries.seriesMatchingLabel("bad label", "x")).toThrow()
    expect(() => ownerRuleQueries.seriesMatchingLabel("ns", "(?=x)")).toThrow()
  })
})

describe("team savings", () => {
  const teams = [team("payments", [{ kind: "job", pattern: "payments-.*" }]), team("search", [{ kind: "job", pattern: "search" }])]
  const ownership = assignOwnership(snapshot, teams)

  it("builds a team snapshot", () => {
    const scoped = ownerSnapshot(snapshot, ownership.owners[0])
    expect(scoped.totalSeries).toBe(500)
    expect(scoped.metrics.map((metric) => metric.metric)).toEqual(["http_requests_total", "payments_charges_total"])
    expect(scoped.jobs).toEqual([{ job: "payments-api", seriesCount: 500, percentageOfTotal: 100, metricCount: 2 }])
    expect(scoped.seriesByMetricJob?.http_requests_total).toEqual({ "payments-api": 400 })
  })

  it("splits a metric drop by owned series and scales measured impacts", () => {
    const rules = [
      createRule({ kind: "drop_metric", selector: { metric: "http_requests_total" }, origin: "user" }),
      {
        ...createRule({ kind: "drop_labels", selector: { metric: "search_queries_total" }, labels: ["q"], origin: "user" }),
        impact: { seriesBefore: 50, seriesAfter: 10, exact: true, mergesSeries: true, measuredAt: "" },
      },
      createRule({ kind: "drop_metric", selector: { metric: "node_cpu_seconds_total" }, origin: "user", status: "proposed" }),
    ]
    const payments = ruleOwnerSavings(snapshot, ownership.owners[0], rules, {})
    expect(payments.savedSeries).toBe(400)
    expect(payments.rules).toHaveLength(1)
    const search = ruleOwnerSavings(snapshot, ownership.owners[1], rules, {})
    expect(search.savedSeries).toBe(340)
    expect(search.rules.map((item) => item.savedSeries)).toEqual([300, 40])
    const unowned = ruleOwnerSavings(snapshot, ownership.unattributed, rules, {})
    expect(unowned.savedSeries).toBe(0)
  })

  it("scales a job-scoped measured impact to the team's share", () => {
    const rule = {
      ...createRule({ kind: "drop_labels", selector: { metric: "http_requests_total", job: "search" }, labels: ["path"], origin: "user" }),
      impact: { seriesBefore: 300, seriesAfter: 100, exact: true, mergesSeries: true, measuredAt: "" },
    }
    const labelRule = { kind: "label" as const, label: "ns", pattern: "x" }
    const split = assignOwnership(snapshot, [team("x", [labelRule])], {
      [labelRuleKey(labelRule)]: [{ job: "search", metric: "http_requests_total", seriesCount: 150 }],
    })
    expect(ruleOwnerSavings(snapshot, split.owners[0], [rule], {}).savedSeries).toBe(100)
    expect(ruleOwnerSavings(snapshot, split.unattributed, [rule], {}).savedSeries).toBe(100)
  })
})

describe("team suggestions", () => {
  it("groups jobs by namespace or first name token", () => {
    const teams = suggestOwners([
      { job: "payments-api", seriesCount: 100 },
      { job: "payments_worker", seriesCount: 50 },
      { job: "payments", seriesCount: 5 },
      { job: "kube/apiserver", seriesCount: 300 },
      { job: "kube/scheduler", seriesCount: 30 },
      { job: "node", seriesCount: 10 },
      { job: "", seriesCount: 999 },
    ])
    expect(teams.map((item) => item.name)).toEqual(["kube", "payments", "node"])
    expect(teams.map((item) => item.rules[0])).toEqual([
      { kind: "job", pattern: "kube/.*" },
      { kind: "job", pattern: "payments([-_.:].*)?" },
      { kind: "job", pattern: "node" },
    ])
    const ownership = assignOwnership(
      buildSnapshotFromRows(
        [
          { job: "payments", metric: "up", seriesCount: 1 },
          { job: "payments-api", metric: "up", seriesCount: 1 },
          { job: "paymentsx", metric: "up", seriesCount: 1 },
        ],
        null,
        5
      ),
      teams
    )
    expect(ownership.owners[1].series).toBe(2)
    expect(suggestOwners([{ job: "a", seriesCount: 1 }, { job: "b", seriesCount: 2 }], 1).map((item) => item.name)).toEqual(["b"])
  })
})

describe("team import and export", () => {
  const teams: Owner[] = [
    {
      id: "t1",
      name: "Payments",
      color: "#e6522c",
      rules: [
        { kind: "job", pattern: "payments-.*" },
        { kind: "metric_prefix", pattern: "payments_" },
        { kind: "label", label: "namespace", pattern: "payments-(prod|dev)" },
        { kind: "job", pattern: " spaced " },
        { kind: "job", pattern: '"quoted' },
      ],
    },
    { id: "t2", name: "Search [core]", color: "#2a9d8f", rules: [] },
  ]
  const strip = (list: Owner[]) => list.map((item) => ({ name: item.name, color: item.color, rules: item.rules }))

  it("round-trips the text format", () => {
    const text = ownersToText(teams)
    expect(text).toContain("[Payments] #e6522c\njob payments-.*\nmetric payments_\nlabel namespace payments-(prod|dev)\n")
    const parsed = parseOwnersText(text)
    expect(parsed.errors).toEqual([])
    expect(strip(parsed.owners)).toEqual(strip(teams))
    expect(strip(parseOwners(text).owners)).toEqual(strip(teams))
  })

  it("round-trips JSON, keeping ids", () => {
    const parsed = parseOwners(ownersToJson(teams))
    expect(parsed.errors).toEqual([])
    expect(parsed.owners).toEqual(teams)
    expect(parseOwners(JSON.stringify(teams)).owners).toEqual(teams)
  })

  it("reports bad lines and entries without failing the rest", () => {
    const parsed = parseOwnersText("job orphan\n[A]\njob (x\nlabel only\nowner x\nmetric a_\n[]\n")
    expect(parsed.owners.map((item) => [item.name, item.rules.length])).toEqual([["A", 1]])
    expect(parsed.errors).toHaveLength(5)
    expect(parseOwnersJson("{").errors[0]).toMatch(/JSON/)
    const json = parseOwnersJson(JSON.stringify({ teams: [{ name: "" }, { id: "x", name: "B", rules: [{ kind: "nope", pattern: "a" }] }, { id: "x", name: "C" }] }))
    expect(json.owners.map((item) => item.name)).toEqual(["B", "C"])
    expect(json.owners[1].id).not.toBe("x")
    expect(json.errors).toHaveLength(2)
  })
})
