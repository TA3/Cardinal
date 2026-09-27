import { describe, expect, it } from "vitest"

import {
  describeDropRule,
  dropRuleKey,
  exemptionProblem,
  logApplyDiffs,
  planLogApply,
  planLogRevert,
  recommendationRows,
  recommendationToLogRule,
  type AdaptiveLogsRecommendation,
  type LogAdaptiveBackup,
} from "@/lib/core/logs/adaptive-apply"
import { tokensToRegex } from "@/lib/core/logs/patterns"
import {
  buildLogAttribution,
  logAttributionSelectors,
  ruleSplitSelectors,
  splitLogRuleSavings,
  volumeCells,
  volumeChainRows,
} from "@/lib/core/logs/attribution"
import { compileAdaptiveLogs, type AdaptiveLogsDropRule } from "@/lib/core/logs/compile/adaptive-logs"
import { logPrDescription } from "@/lib/core/logs/pr"
import { parseLokiRulesJson, summarizeLogRule, type LogUsageEvidence } from "@/lib/core/logs/logql-usage"
import { createLogRule, logRuleKey, type LogRuleInput } from "@/lib/core/logs/rules"
import { fromLogRuleSet, logRuleSetJson, logShareHash, parseLogRuleSetJson, readLogShareHash, toLogRuleSet } from "@/lib/core/logs/share"
import type { LogRule, LogRuleImpact } from "@/lib/core/logs/types"

const api = { matchers: [{ label: "service_name", op: "=" as const, value: "api" }] }

function rule(input: Partial<LogRuleInput> & Pick<LogRuleInput, "kind">, impact?: Partial<LogRuleImpact>): LogRule {
  const created = createLogRule({ selector: api, origin: "user", ...input } as LogRuleInput)
  return impact ? { ...created, impact: { bytesBefore: 0, bytesAfter: 0, exact: true, measuredAt: "2026-09-26T00:00:00Z", ...impact } } : created
}

function remote(partial: Partial<AdaptiveLogsDropRule> & { body: AdaptiveLogsDropRule["body"] }): AdaptiveLogsDropRule {
  return { segment_id: "__global__", name: "remote", version: 3, disabled: false, ...partial }
}

describe("log rule share links", () => {
  const rules = [
    rule({ kind: "drop_lines", line: { levels: ["debug"] }, rationale: "noisy" }),
    rule({ kind: "sample", keep: 0.1, line: { regex: "GET /health" } }),
    rule({ kind: "label_to_metadata", label: "pod" }),
    rule({ kind: "retention", days: 7 }),
    rule({ kind: "drop_streams" }),
    rule({ kind: "drop_label", label: "request_id", selector: { matchers: [] } }),
  ]

  it("round-trips every kind through a hash as proposals", () => {
    const parsed = readLogShareHash(logShareHash(rules))!
    expect(parsed.warnings).toEqual([])
    expect(parsed.rules.map(logRuleKey)).toEqual(rules.map(logRuleKey))
    expect(parsed.rules.every((item) => item.status === "proposed" && item.origin === "import")).toBe(true)
    expect(parsed.rules[0].rationale).toBe("noisy")
    expect(parsed.rules[1]).toMatchObject({ kind: "sample", keep: 0.1 })
    expect(parsed.rules[3]).toMatchObject({ kind: "retention", days: 7 })
  })

  it("ignores other hashes and the metric rules key", () => {
    expect(readLogShareHash("#rules=abc")).toBeNull()
    expect(readLogShareHash("")).toBeNull()
  })

  it("refuses invalid rules with a warning instead of importing them", () => {
    const set = toLogRuleSet(rules.slice(0, 1))
    const bad = {
      ...set,
      rules: [
        ...set.rules,
        { kind: "sample", selector: [], keep: 1.5 },
        { kind: "drop_label", selector: [{ label: "a", op: "=", value: "x" }], label: "a b" },
        { kind: "drop_streams", selector: [{ label: "a", op: "==", value: "x" }] },
        { kind: "retention", selector: [{ label: "a", op: "=", value: "x" }], days: 0 },
        { kind: "evil" },
      ],
    }
    const parsed = fromLogRuleSet(bad)
    expect(parsed.rules).toHaveLength(1)
    expect(parsed.warnings).toHaveLength(5)
  })

  it("rejects other formats and versions", () => {
    expect(() => parseLogRuleSetJson('{"format":"cardinal.rules","version":1,"rules":[]}')).toThrow(/log rule set/)
    expect(() => fromLogRuleSet({ format: "cardinal.logrules", version: 9, rules: [] })).toThrow(/version/)
    expect(logRuleSetJson([])).toContain('"format": "cardinal.logrules"')
  })

  it("strips control characters from rationales", () => {
    const parsed = fromLogRuleSet({ format: "cardinal.logrules", version: 1, rules: [{ kind: "drop_streams", selector: api.matchers, rationale: "a\nb\u0000c" }] })
    expect(parsed.rules[0].rationale).toBe("a b c")
  })
})

describe("Adaptive Logs apply plan", () => {
  const compiled = compileAdaptiveLogs([
    rule({ kind: "drop_lines", line: { levels: ["debug", "trace"] } }),
    rule({ kind: "sample", keep: 0.25, selector: { matchers: [{ label: "service_name", op: "=", value: "web" }] } }),
    rule({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "batch" }] } }),
  ]).dropRules

  it("creates new targets and leaves identical ones alone", () => {
    const existing = [remote({ id: "r1", body: { stream_selector: '{service_name="batch"}', drop_rate: 100 } })]
    const plan = planLogApply(compiled, existing)
    expect(plan.changes.map((change) => change.type)).toEqual(["create", "create"])
    expect(plan.unchanged.map((item) => item.id)).toEqual(["r1"])
  })

  it("matches targets regardless of matcher order, spacing and level case", () => {
    const a = remote({ body: { stream_selector: '{ b="2" , a="1" }', drop_rate: 5, levels: ["DEBUG", "info"] } })
    const b = remote({ body: { stream_selector: '{a="1",b="2"}', drop_rate: 50, levels: ["info", "debug"] } })
    expect(dropRuleKey(a)).toBe(dropRuleKey(b))
    expect(dropRuleKey(a)).not.toBe(dropRuleKey({ ...b, segment_id: "seg" }))
  })

  it("raises a weaker or disabled remote rule, keeping its id and version", () => {
    const existing = [
      remote({ id: "w", version: 7, body: { stream_selector: '{service_name="web"}', drop_rate: 50 } }),
      remote({ id: "d", version: 2, disabled: true, body: { stream_selector: '{service_name="batch"}', drop_rate: 100 } }),
    ]
    const plan = planLogApply(compiled, existing)
    const updates = plan.changes.filter((change) => change.type === "update")
    expect(updates).toHaveLength(2)
    const byId = (id: string) => updates.find((change) => change.type === "update" && change.before.id === id)
    expect(byId("w")).toMatchObject({ rule: { id: "w", version: 7, body: { drop_rate: 75 } } })
    expect(byId("d")).toMatchObject({ rule: { id: "d", disabled: false, body: { drop_rate: 100 } } })
    const diffs = logApplyDiffs(plan)
    expect(diffs.find((diff) => diff.selector.includes("web"))).toMatchObject({ before: "drop 50% of lines", after: "drop 75% of lines" })
    expect(diffs.find((diff) => diff.type === "create")?.before).toBeNull()
  })

  it("never loosens a remote rule that already drops more", () => {
    const existing = [remote({ id: "w", body: { stream_selector: '{service_name="web"}', drop_rate: 90 } })]
    const plan = planLogApply(compiled, existing)
    expect(plan.kept.map((item) => item.remote.id)).toEqual(["w"])
    expect(plan.changes.some((change) => change.type === "update")).toBe(false)
  })

  it("describes drop rules", () => {
    expect(describeDropRule({ stream_selector: "{a=\"b\"}", drop_rate: 90, levels: ["info"], log_line_contains: ["health"] })).toBe(
      'drop 90% of info lines containing "health"'
    )
    expect(describeDropRule({ stream_selector: "{a=\"b\"}", drop_rate: 100 }, true)).toBe("(disabled) drop 100% of lines")
  })
})

describe("Adaptive Logs revert", () => {
  const body = { stream_selector: '{service_name="web"}', drop_rate: 75 }
  const before = remote({ id: "w", version: 7, body: { ...body, drop_rate: 50 } })
  const backup: LogAdaptiveBackup = {
    appliedAt: "2026-09-26T10:00:00Z",
    updated: [before],
    created: ["c1"],
    applied: { w: body, c1: { stream_selector: '{service_name="batch"}', drop_rate: 100 } },
    exemptions: ["e1"],
  }

  it("deletes created rules, restores updated ones with the current version, and removes exemptions", () => {
    const current = [
      remote({ id: "w", version: 8, body }),
      remote({ id: "c1", name: "batch", version: 1, body: { stream_selector: '{ service_name="batch" }', drop_rate: 100 } }),
      remote({ id: "other", body: { stream_selector: '{x="y"}', drop_rate: 10 } }),
    ]
    const plan = planLogRevert(backup, current)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.steps).toEqual([
      { type: "delete", id: "c1", name: "batch" },
      { type: "restore", id: "w", rule: { ...before, version: 8 } },
      { type: "delete_exemption", id: "e1" },
    ])
    expect(plan.missing).toBe(0)
  })

  it("refuses when a rule was edited since the apply", () => {
    const current = [remote({ id: "w", version: 9, body: { ...body, drop_rate: 60 } }), remote({ id: "c1", body: backup.applied.c1 })]
    const plan = planLogRevert(backup, current)
    expect(plan).toMatchObject({ ok: false })
    const disabled = planLogRevert(backup, [remote({ id: "w", disabled: true, body }), remote({ id: "c1", body: backup.applied.c1 })])
    expect(disabled.ok).toBe(false)
  })

  it("skips rules deleted since, and has nothing to revert without a backup", () => {
    const plan = planLogRevert(backup, [])
    expect(plan).toMatchObject({ ok: true, missing: 2 })
    expect(planLogRevert(null, [])).toMatchObject({ ok: false })
  })
})

describe("Adaptive Logs recommendations", () => {
  const rec = (partial: Partial<AdaptiveLogsRecommendation>): AdaptiveLogsRecommendation => ({
    tokens: ["level=info msg=\"GET ", "<*>", "\" status=200"],
    locked: false,
    configured_drop_rate: 0,
    volume: 15 * 1024 ** 3,
    ingested_lines: 1000,
    queried_lines: 10,
    recommended_drop_rate: 80,
    superseded: false,
    ...partial,
  })

  it("turns tokens into an escaped, unanchored regex", () => {
    expect(tokensToRegex(["<*>", " a.b(", "<*>", "<*>", "c", "<*>"])).toBe(" a\\.b\\(.*?c")
  })

  it("ranks by the bytes per day the recommended rate would add", () => {
    const rows = recommendationRows([rec({ recommended_drop_rate: 10 }), rec({ recommended_drop_rate: 90, configured_drop_rate: 50 })])
    expect(rows[0].savedBytesPerDay).toBeCloseTo(1024 ** 3 * 0.4)
    expect(rows[1].savedBytesPerDay).toBeCloseTo(1024 ** 3 * 0.1)
    expect(rows[0].bytesPerDay).toBeCloseTo(1024 ** 3)
    expect(rows[0].queriedShare).toBeCloseTo(0.01)
  })

  it("proposes a sample (or a drop at 100%) of the pattern", () => {
    const sample = recommendationToLogRule(rec({}))!
    expect(sample).toMatchObject({ kind: "sample", keep: 0.2, status: "proposed", origin: "import", line: { regex: 'level=info msg="GET .*?" status=200' } })
    expect(createLogRule(sample).kind).toBe("sample")
    expect(recommendationToLogRule(rec({ recommended_drop_rate: 100 }))).toMatchObject({ kind: "drop_lines" })
    expect(recommendationToLogRule(rec({ recommended_drop_rate: 0 }))).toBeNull()
    expect(recommendationToLogRule(rec({ locked: true }))).toBeNull()
    expect(recommendationToLogRule(rec({ tokens: ["<*>"] }))).toBeNull()
  })

  it("validates exemptions", () => {
    expect(exemptionProblem({ stream_selector: '{service_name="login"}' })).toBeNull()
    expect(exemptionProblem({ stream_selector: '{service_name="login"}', active_interval: "1h" })).toBeNull()
    expect(exemptionProblem({ stream_selector: '{service_name="login"}', active_interval: "7d" })).toMatch(/Duration/)
    expect(exemptionProblem({ stream_selector: '{service_name="login"} |= "x"' })).toMatch(/line filters/)
    expect(exemptionProblem({ stream_selector: '{a=""}' })).toMatch(/empty/)
    expect(exemptionProblem({ stream_selector: "service_name=login" })).not.toBeNull()
  })
})

describe("logs attribution", () => {
  const chain = ["team", "namespace"]
  const rows: Array<{ labels: Record<string, string>; bytes: number }> = [
    { labels: { team: "payments", namespace: "pay" }, bytes: 600 },
    { labels: { namespace: "infra" }, bytes: 300 },
    { labels: {}, bytes: 100 },
  ]

  it("builds selectors from validated names", () => {
    expect(logAttributionSelectors.all("service_name")).toBe('{service_name=~".+"}')
    expect(logAttributionSelectors.level("service_name", chain, 0)).toBe('{service_name=~".+"}')
    expect(logAttributionSelectors.level("service_name", chain, 1)).toBe('{service_name=~".+", team=""}')
    expect(logAttributionSelectors.unlabelled("service_name", chain)).toBe('{service_name=~".+", team="", namespace=""}')
    expect(logAttributionSelectors.labelRule("service_name", chain, "cluster", "prod-.*")).toBe(
      '{service_name=~".+", team="", namespace="", cluster=~"prod-.*"}'
    )
    expect(() => logAttributionSelectors.labelRule("service_name", chain, "bad label", "x")).toThrow()
    expect(() => logAttributionSelectors.labelRule("service_name", chain, "cluster", "(")).toThrow()
  })

  it("resolves the chain on bytes and hands the rest to job rules on the group label", () => {
    const attribution = buildLogAttribution({
      chain,
      chainRows: volumeChainRows(rows, chain),
      unlabelled: { cells: volumeCells([{ labels: { service_name: "billing" }, bytes: 100 }], "service_name"), exact: true },
      owners: [{ id: "o1", name: "Billing", rules: [{ kind: "job", pattern: "bill.*" }, { kind: "metric_prefix", pattern: "" }] }],
    })
    expect(attribution.totalSeries).toBe(1000)
    expect(attribution.owners.map((owner) => [owner.name, owner.series, owner.source])).toEqual([
      ["payments", 600, "label"],
      ["infra", 300, "label"],
      ["Billing", 100, "rule"],
    ])
    expect(attribution.unattributed.series).toBe(0)
  })

  it("splits each rule's saving by where its bytes sit", () => {
    const attribution = buildLogAttribution({
      chain,
      chainRows: volumeChainRows(rows, chain),
      unlabelled: { cells: volumeCells([{ labels: { service_name: "billing" }, bytes: 60 }, { labels: { service_name: "misc" }, bytes: 40 }], "service_name"), exact: true },
      owners: [{ id: "o1", name: "Billing", rules: [{ kind: "job", pattern: "bill.*" }] }],
    })
    const api = rule({ kind: "drop_streams" }, { bytesBefore: 400, bytesAfter: 0 })
    const debug = rule({ kind: "drop_lines", selector: { matchers: [] }, line: { levels: ["debug"] } }, { bytesBefore: 1000, bytesAfter: 900, exact: false })
    const unmeasured = rule({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "x" }] } })
    const { byOwner, pending } = splitLogRuleSavings(attribution, [api, debug, unmeasured], null, {
      [api.id]: { levels: [[{ labels: { team: "payments" }, bytes: 300 }], [{ labels: { namespace: "infra" }, bytes: 100 }]], unlabelled: [] },
      [debug.id]: {
        levels: [[{ labels: { team: "payments" }, bytes: 600 }], [{ labels: { namespace: "infra" }, bytes: 300 }]],
        unlabelled: [{ labels: { service_name: "billing" }, bytes: 60 }, { labels: { service_name: "misc" }, bytes: 40 }],
      },
    })
    expect(pending).toBe(0)
    const payments = byOwner.get("label:0:payments")!
    expect(payments.savedBytes).toBe(300 + 60)
    expect(payments.isEstimate).toBe(true)
    expect(byOwner.get("label:1:infra")!.savedBytes).toBe(100 + 30)
    expect(byOwner.get("o1")!.savedBytes).toBe(6)
    expect(byOwner.get(attribution.unattributed.id)!.savedBytes).toBe(4)
    expect(splitLogRuleSavings(attribution, [api], null, {}).pending).toBe(1)
  })

  it("builds split selectors from the rule's matchers", () => {
    const split = ruleSplitSelectors({ selector: api }, "service_name", chain)!
    expect(split.levels).toEqual(['{service_name="api", service_name=~".+"}', '{service_name="api", service_name=~".+", team=""}'])
    expect(split.unlabelled).toBe('{service_name="api", service_name=~".+", team="", namespace=""}')
  })
})

describe("logs PR description", () => {
  it("lists rules with per-day savings, cost and rationale", () => {
    const rules = [
      rule({ kind: "drop_lines", line: { levels: ["debug"] }, rationale: "debug | noise" }, { bytesBefore: 4 * 1024 ** 3, bytesAfter: 2 * 1024 ** 3, streamsBefore: 5, streamsAfter: 5 }),
      rule({ kind: "label_to_metadata", label: "pod" }),
    ]
    const text = logPrDescription(rules, {
      generatedAt: new Date("2026-09-26T00:00:00Z"),
      target: "Grafana Alloy loki.process",
      rangeDays: 1,
      totalBytesPerDay: 10 * 1024 ** 3,
      totalStreams: 100,
      savings: { savedBytes: 2 * 1024 ** 3, savedStreams: 0, percent: 20, streamsPercent: 0, isEstimate: true },
      cost: (bytes) => (bytes / 1024 ** 3) * 0.5,
      formatCost: (amount) => `$${amount.toFixed(2)}`,
      usage: { [rules[0].id]: null },
    })
    expect(text).toContain("## Reduce log volume")
    expect(text).toContain("about 2.00 GB of ingest per day (20.0% of 10.0 GB/day), ≈ $1.00/day")
    expect(text).toContain("| 2.00 GB/day | – | $1.00 | none found |")
    expect(text).toContain("not measured")
    expect(text).toContain("debug \\| noise")
  })
})

describe("log rule usage in Loki rules", () => {
  const rulerRules = parseLokiRulesJson({
    status: "success",
    data: {
      groups: [
        {
          name: "api",
          rules: [
            { name: "ApiErrors", type: "alerting", query: 'sum by (pod) (rate({service_name="api"} |= "error" [5m])) > 1' },
            { name: "web:bytes", type: "recording", query: 'sum(bytes_over_time({service_name=~"web|shop"}[1m]))' },
            { name: "broken", type: "alerting" },
          ],
        },
      ],
    },
  })
  const evidence: LogUsageEvidence = { rules: rulerRules, dashboards: null }
  const found = (input: LogRuleInput) => summarizeLogRule(rule(input), evidence)?.found.join(" ") ?? null

  it("reads the Prometheus-style payload and finds selectors", () => {
    expect(rulerRules.map((item) => item.name)).toEqual(["ApiErrors", "web:bytes"])
    expect(() => parseLokiRulesJson(null)).toThrow()
  })

  it("flags rules whose selectors overlap, and label rules only when the query uses the label", () => {
    expect(found({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "api" }] }, origin: "user" })).toContain("ApiErrors")
    const api = { selector: { matchers: [{ label: "service_name", op: "=" as const, value: "api" }] }, origin: "user" as const }
    expect(found({ ...api, kind: "drop_label", label: "pod" })).toContain("ApiErrors")
    expect(summarizeLogRule(rule({ ...api, kind: "drop_label", label: "cluster" }), evidence)?.used).toBe(false)
    // Rules read recent lines: retention doesn't touch them.
    const retention = summarizeLogRule(rule({ ...api, kind: "retention", days: 3 }), evidence)
    expect(retention?.used).toBe(false)
    expect(retention?.clear[0]).toMatch(/retention doesn't remove/)
    expect(summarizeLogRule(rule({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "db" }] }, origin: "user" }), evidence)?.used).toBe(false)
    expect(found({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "shop" }] }, origin: "user" })).toContain("web:bytes")
    // Selectors on other labels may include these streams: not "used", but said so.
    const byApp = summarizeLogRule(rule({ kind: "drop_streams", selector: { matchers: [{ label: "app", op: "=", value: "api" }] }, origin: "user" }), evidence)
    expect(byApp?.used).toBe(false)
    expect(byApp?.unchecked.join(" ")).toContain("may include these")
    // An unscoped rule touches every stream a rule reads.
    expect(found({ kind: "drop_lines", selector: { matchers: [] }, line: { levels: ["debug"] }, origin: "user" })).toContain("ApiErrors, web:bytes")
    // Keep rules remove nothing: no evidence to show.
    expect(summarizeLogRule(rule({ ...api, kind: "keep", rationale: "audit" }), evidence)).toBeNull()
  })
})
