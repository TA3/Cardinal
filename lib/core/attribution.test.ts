import { describe, expect, it } from "vitest"

import {
  DEFAULT_ATTRIBUTION,
  attributionChain,
  attributionQueries,
  buildAttribution,
  estimateLabelOwnerSavings,
  jobOwnersFromChain,
  labelOwnerId,
  migrateTeamsToAttribution,
  normalizeAttribution,
  ownerSelector,
  resolveChain,
  viaText,
  type ChainRow,
} from "@/lib/core/attribution"
import { UNATTRIBUTED_ID, ownerRuleQueries, type Owner } from "@/lib/core/owner-rules"
import { createRule } from "@/lib/core/rules"
import { buildSnapshotFromRows } from "@/lib/core/snapshot"

const chain = ["team", "namespace", "service"]
const row = (labels: Record<string, string>, seriesCount: number): ChainRow => ({ labels: { team: "", namespace: "", service: "", ...labels }, seriesCount })
const owner = (id: string, rules: Owner["rules"]): Owner => ({ id, name: id, rules })

describe("attribution chain", () => {
  it("keeps valid, set labels in order without repeats", () => {
    expect(attributionChain(["team", "", "service"])).toEqual(["team", "service"])
    expect(attributionChain(["team", "team", "namespace"])).toEqual(["team", "namespace"])
    expect(attributionChain(["__name__", "9bad", "app"])).toEqual(["app"])
    expect(attributionChain(["a", "b", "c", "d"])).toEqual(["a", "b", "c"])
    expect(attributionChain(["", "", ""])).toEqual([])
  })

  it("builds queries from validated names and escaped values", () => {
    expect(attributionQueries.seriesByChain(chain)).toBe('count by (team, namespace, service) ({__name__=~".+"})')
    expect(attributionQueries.seriesByChain(chain, 'a"b')).toBe('count by (team, namespace, service) ({__name__=~".+",job="a\\"b"})')
    expect(attributionQueries.unlabelledByJobMetric(chain)).toBe('count by (job, __name__) ({__name__=~".+",team="",namespace="",service=""})')
    expect(attributionQueries.seriesByJobAndChain(["team"])).toBe('count by (job, team) ({__name__=~".+"})')
    expect(ownerSelector(chain, 1, 'pay"ments')).toBe('{__name__=~".+",team="",namespace="pay\\"ments"}')
    expect(attributionQueries.ownerTopMetrics(chain, 0, "a")).toBe('topk(20, count by (__name__) ({__name__=~".+",team="a"}))')
    expect(attributionQueries.ownerBreakdown(chain, 0, "a")).toBe('topk(20, count by (namespace) ({__name__=~".+",team="a"}))')
    expect(attributionQueries.ownerBreakdown(chain, 2, "a")).toBe('topk(20, count by (job) ({__name__=~".+",team="",namespace="",service="a"}))')
    expect(() => attributionQueries.seriesByChain(["bad-label"])).toThrow()
    expect(ownerRuleQueries.seriesMatchingLabel("env", "prod|staging", ["team"])).toBe(
      'count by (job, __name__) ({__name__=~".+",team="",env=~"prod|staging"})'
    )
  })

  it("resolves each row to its first set label, the rest stays unlabelled", () => {
    const resolved = resolveChain(
      [
        row({ team: "payments", namespace: "pay" }, 100),
        row({ team: "payments" }, 20),
        row({ namespace: "search" }, 50),
        row({ namespace: "payments" }, 5),
        row({ service: "api" }, 7),
        row({}, 30),
      ],
      chain
    )
    expect(resolved.owners.map((item) => [item.value, item.dimension, item.series])).toEqual([
      ["payments", 0, 120],
      ["search", 1, 50],
      ["api", 2, 7],
      ["payments", 1, 5],
    ])
    expect(resolved.labelled).toBe(182)
    expect(resolved.unlabelled).toBe(30)
  })

  it("sends unlabelled series through custom rules, then Unattributed", () => {
    const attribution = buildAttribution({
      chain,
      chainRows: [row({ team: "payments" }, 600), row({ namespace: "search" }, 200), row({}, 200)],
      unlabelled: {
        cells: [
          { job: "node", metric: "node_cpu_seconds_total", seriesCount: 120 },
          { job: "blackbox", metric: "probe_success", seriesCount: 80 },
        ],
        exact: true,
      },
      owners: [owner("platform", [{ kind: "job", pattern: "node" }])],
    })
    expect(attribution.totalSeries).toBe(1000)
    expect(attribution.owners.map((item) => [item.name, item.source, item.series, item.percent])).toEqual([
      ["payments", "label", 600, 60],
      ["search", "label", 200, 20],
      ["platform", "rule", 120, 12],
    ])
    expect(attribution.unattributed).toMatchObject({ id: UNATTRIBUTED_ID, series: 80, percent: 8 })
    expect(attribution.seriesByLabel).toEqual([600, 200, 0])
    expect(attribution.seriesByRules).toBe(120)
    expect(viaText(attribution.owners[1])).toBe("via namespace")
    expect(viaText(attribution.owners[2])).toBe("via rules")
  })

  it("uses the whole snapshot for custom rules without labels", () => {
    const attribution = buildAttribution({
      chain: [],
      unlabelled: { cells: [{ job: "a", metric: "m", seriesCount: 10 }, { job: "b", metric: "m", seriesCount: 30 }], exact: true },
      owners: [owner("A", [{ kind: "job", pattern: "a" }])],
    })
    expect(attribution.owners.map((item) => item.series)).toEqual([10])
    expect(attribution.unattributed.series).toBe(30)
  })

  it("gives each job its owners, with job rules for unlabelled series", () => {
    const owners = jobOwnersFromChain(
      [
        { labels: { job: "api", team: "payments" }, seriesCount: 90 },
        { labels: { job: "api", team: "" }, seriesCount: 10 },
        { labels: { job: "node", team: "" }, seriesCount: 40 },
        { labels: { job: "probe", team: "" }, seriesCount: 5 },
      ],
      ["team"],
      [owner("platform", [{ kind: "job", pattern: "node" }])]
    )
    expect(owners.get("api")?.map((item) => [item.name, item.series])).toEqual([
      ["payments", 90],
      ["Unattributed", 10],
    ])
    expect(owners.get("api")?.[0].id).toBe(labelOwnerId(0, "payments"))
    expect(owners.get("node")?.[0]).toMatchObject({ name: "platform", unattributed: false })
    expect(owners.get("probe")?.[0]).toMatchObject({ unattributed: true })
  })

  it("estimates a label owner's savings from its share of each rule's metric", () => {
    const snapshot = buildSnapshotFromRows(
      [
        { job: "api", metric: "http_requests_total", seriesCount: 400 },
        { job: "api", metric: "other_total", seriesCount: 100 },
      ],
      null,
      20
    )
    const rules = [createRule({ kind: "drop_metric", selector: { metric: "http_requests_total" }, origin: "user" })]
    const estimate = estimateLabelOwnerSavings(snapshot, { metrics: [{ metric: "http_requests_total", series: 100 }] }, rules, {})
    expect(estimate.savedSeries).toBe(100)
    expect(estimate.isEstimate).toBe(true)
    expect(estimateLabelOwnerSavings(snapshot, { metrics: [{ metric: "other_total", series: 50 }] }, rules, {}).savedSeries).toBe(0)
  })
})

describe("attribution migration", () => {
  const teams = [{ id: "team_1", name: "Payments", color: "#5b7fd6", rules: [{ kind: "job", pattern: "payments-.*" }] }]

  it("turns teams into enabled custom rules without labels", () => {
    const migrated = migrateTeamsToAttribution({ teams })
    expect(migrated).toEqual({ enabled: true, labels: ["", "", ""], owners: teams })
    expect(attributionChain(migrated.labels)).toEqual([])
  })

  it("leaves attribution off without teams, and repairs stored settings", () => {
    expect(migrateTeamsToAttribution({ teams: [] })).toEqual(DEFAULT_ATTRIBUTION)
    expect(migrateTeamsToAttribution({})).toEqual(DEFAULT_ATTRIBUTION)
    expect(normalizeAttribution({ enabled: true, labels: ["team"], owners: [{ name: "x", rules: [{ kind: "nope" }] }] })).toMatchObject({
      enabled: true,
      labels: ["team", "", ""],
      owners: [{ name: "x", rules: [] }],
    })
  })
})
