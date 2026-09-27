import { parse } from "yaml"
import { describe, expect, it } from "vitest"

import { ruleSpec } from "@/lib/agent/tools"
import { adaptiveChangeDiffs, compileAdaptiveMetrics, planRevert } from "@/lib/core/compile/adaptive-metrics"
import { renderAlloy } from "@/lib/core/compile/alloy"
import { planRelabel } from "@/lib/core/compile/plan"
import { renderPrometheus } from "@/lib/core/compile/prometheus"
import { parseAlloyRelabel } from "@/lib/core/parse/alloy"
import { parsePrometheusRelabel } from "@/lib/core/parse/prometheus"
import { createLimiter, runWithConcurrency } from "@/lib/core/concurrency"
import { familyMembers, histogramFamily } from "@/lib/core/families"
import { normalizeLegacyJob } from "@/lib/core/jobs"
import { queries, selector } from "@/lib/core/promql"
import { parseLiteralAlternation, regexProblem } from "@/lib/core/regex"
import { activateOrCreate, createRule, isShadowed, mergeRules, ruleKey, shadowedBy, type Rule } from "@/lib/core/rules"
import { classifyValue, detectIdLike, generalizePath } from "@/lib/core/id-like"
import { base64UrlDecode, base64UrlEncode, parseRuleSetJson, readShareHash, shareHash } from "@/lib/core/share"
import { diffAgainstBaseline, updateBaseline } from "@/lib/core/rule-diff"
import { prDescription, renderHeader } from "@/lib/core/report"
import { confirmationKey, guardedLabel, orphanWarning, summarizeEvidence } from "@/lib/core/usage-gate"
import { computeExpectedSavings, formatDelta, snapshotImpact } from "@/lib/core/savings"
import { buildSnapshotFromRows, type Snapshot } from "@/lib/core/snapshot"
import { legacyRedirect, signalEntry, signalFromPath } from "@/lib/core/signals"
import type { JobDrilldownResponse } from "@/lib/prometheus/types"

// lib/sources needs DOM types, which this (worker) project lacks, so the
// source modules are loaded at runtime with minimal local types.
interface Connection {
  baseUrl: string
  mode: "direct" | "proxy"
}
interface Sources {
  adaptiveMetricsBaseUrl(baseUrl: string): string | null
  saveAggregationRules(connection: Connection, rules: unknown[], etag?: string): Promise<string>
  fetchJobDrilldown(connection: Connection, job: string): Promise<JobDrilldownResponse>
  fetchSeriesByJob(connection: Connection, metric: string): Promise<Array<{ job: string; seriesCount: number }>>
  fetchSnapshot(connection: Connection, topN: number): Promise<Snapshot>
}
const sourceModules = ["@/lib/sources/adaptive-metrics", "@/lib/sources/prometheus"]
const loadSources = async () =>
  Object.assign({}, ...(await Promise.all(sourceModules.map((path) => import(/* @vite-ignore */ path))))) as Sources

const scoped = (metric: string, job?: string) => (job === undefined ? { metric } : { metric, job })
const dropMetric = (metric: string, job?: string) =>
  createRule({ kind: "drop_metric", selector: scoped(metric, job), origin: "user" })
const dropLabels = (metric: string, labels: string[], job?: string, mergesSeries?: boolean) => {
  const rule = createRule({ kind: "drop_labels", selector: scoped(metric, job), labels, origin: "user" })
  if (mergesSeries !== undefined) {
    rule.impact = { seriesBefore: 10, seriesAfter: mergesSeries ? 2 : 10, exact: true, mergesSeries, measuredAt: "" }
  }
  return rule
}
const keys = (rules: Rule[]) => rules.map((rule) => `${ruleKey(rule)}${rule.kind === "drop_labels" ? `[${rule.labels}]` : ""}`).sort()

describe("promql", () => {
  it("escapes label values and rejects invalid identifiers", () => {
    expect(selector({ metric: "up", matchers: { job: 'a"}) or vector(1) #' } })).toBe(
      '{__name__="up",job="a\\"}) or vector(1) #"}'
    )
    expect(() => selector({ metric: "up) or vector(1" })).toThrow(/Invalid metric/)
    expect(() => queries.labelCardinality({ metric: "up" }, "a b")).toThrow(/Invalid label/)
  })
})

describe("regex", () => {
  it("parses literal alternations and rejects patterns", () => {
    expect(parseLiteralAlternation("a|b\\.c|(d|e)")).toEqual(["a", "b.c", "d", "e"])
    expect(parseLiteralAlternation("foo_.*")).toBeNull()
  })
})

describe("relabel compile", () => {
  it("emits YAML that parses even with regex-special job names", () => {
    const rules = [dropMetric("http_requests_total", "prometheus.scrape.default"), dropLabels("rpc_latency", ["pod"], "a.b", false)]
    const yaml = renderPrometheus(planRelabel(rules, { mode: "combined" }))
    const doc = parse(yaml) as { metric_relabel_configs: Array<{ regex: string }> }
    expect(doc.metric_relabel_configs[0].regex).toBe("prometheus\\.scrape\\.default;(http_requests_total)")
  })

  it("never emits lossy label drops as relabel rules", () => {
    const plan = planRelabel([dropLabels("m", ["pod"], undefined, true)], { mode: "combined" })
    expect(plan.sections[0].steps).toHaveLength(0)
    expect(plan.warnings[0]).toMatch(/Adaptive Metrics/)
  })

  it("places unscoped drops in every job emitting the metric when split by job", () => {
    const plan = planRelabel([dropMetric("m")], { mode: "split-by-job", jobsByMetric: { m: ["a", "b"] } })
    expect(plan.sections.map((section) => section.job)).toEqual(["a", "b"])
  })

  it("round-trips through Prometheus YAML and Alloy", () => {
    const rules = [
      dropMetric("a_total"),
      dropMetric("b_total"),
      dropMetric("c_total", "node.exporter"),
      dropLabels("d_seconds", ["instance", "pod"], undefined, false),
      dropLabels("e_bytes", ["id"], "job-x", false),
    ]
    const plan = planRelabel(rules, { mode: "combined" })
    expect(keys(parsePrometheusRelabel(renderPrometheus(plan)).rules)).toEqual(keys(rules))
    const alloy = parseAlloyRelabel(renderAlloy(plan))
    expect(alloy.warnings).toEqual([])
    expect(keys(alloy.rules)).toEqual(keys(rules))
  })

  it("parses Alloy strings containing braces and comments", () => {
    const result = parseAlloyRelabel(`
      prometheus.relabel "x" {
        // rule { fake }
        rule {
          source_labels = ["__name__"]
          regex         = "a{2}|b"
          action        = "drop"
        }
        rule {
          source_labels = ["__name__"]
          regex         = "c|d"
          action        = "drop"
        }
      }`)
    expect(result.ruleCount).toBe(2)
    expect(keys(result.rules)).toEqual(keys([dropMetric("c"), dropMetric("d")]))
    expect(result.warnings[0]).toMatch(/literal/)
  })

  it("reads relabel configs nested in a full prometheus.yml", () => {
    const result = parsePrometheusRelabel(`
scrape_configs:
  - job_name: api
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: 'go_gc_.*|x_total'
        action: drop
      - source_labels: [__name__]
        regex: y_total
        action: drop
`)
    expect(keys(result.rules)).toEqual(keys([dropMetric("y_total", "api")]))
    expect(result.warnings).toHaveLength(1)
  })
})

describe("rules", () => {
  it("merges label drops for the same selector", () => {
    const merged = mergeRules([dropLabels("m", ["a"])], [dropLabels("m", ["b"]), dropMetric("m")])
    expect(keys(merged.rules)).toEqual(keys([dropLabels("m", ["a", "b"]), dropMetric("m")]))
    expect(merged.added).toHaveLength(2)
  })
})

describe("adaptive metrics compile", () => {
  it("adds aggregations, drops, and preserves unrelated existing rules", () => {
    const result = compileAdaptiveMetrics(
      [dropLabels("req_total", ["pod"], undefined, true), dropMetric("junk"), dropMetric("scoped", "a")],
      [{ metric: "other", drop_labels: ["x"], aggregations: ["sum"] }]
    )
    expect(result.rules.map((rule) => rule.metric)).toEqual(["junk", "other", "req_total"])
    expect(result.rules.find((rule) => rule.metric === "req_total")?.aggregations).toEqual(["sum:counter"])
    expect(result.changes).toHaveLength(2)
    expect(result.warnings[0]).toMatch(/scoped to job/)
  })
})

describe("snapshot", () => {
  it("aggregates job/metric rows exactly", () => {
    const snapshot = buildSnapshotFromRows(
      [
        { job: "a", metric: "m1", seriesCount: 30 },
        { job: "b", metric: "m1", seriesCount: 50 },
        { job: "a", metric: "m2", seriesCount: 20 },
      ],
      5,
      1
    )
    expect(snapshot.totalSeries).toBe(100)
    expect(snapshot.metrics[0]).toMatchObject({ metric: "m1", seriesCount: 80, topJob: "b", jobs: ["b", "a"] })
    expect(snapshot.jobs[0]).toMatchObject({ job: "a", seriesCount: 50, metricCount: 2 })
    expect(snapshot.topMetrics).toHaveLength(1)
  })
})

const proposed = (rule: Rule): Rule => ({ ...rule, status: "proposed" })
const rejected = (rule: Rule): Rule => ({ ...rule, status: "rejected" })

describe("config injection (1)", () => {
  it("rejects control characters and long names in agent rule specs", () => {
    const ok = (spec: object) => ruleSpec.safeParse({ kind: "drop_metric", metric: "up", ...spec }).success
    expect(ok({ job: "" })).toBe(true)
    expect(ok({ job: "api server;x" })).toBe(true)
    expect(ok({ job: "api\nscrape_configs:" })).toBe(false)
    expect(ok({ job: "a\u007f" })).toBe(false)
    expect(ok({ job: "a".repeat(201) })).toBe(false)
    expect(ok({ metric: "up}) or vector(1)" })).toBe(false)
    expect(ok({ kind: "drop_labels", labels: ["a-b"] })).toBe(false)
  })

  it("quotes job names in config comments", () => {
    const rules = [dropMetric("m", "evil\nforward_to = []"), dropMetric("m", "x\n- action: keep")]
    const plan = planRelabel(rules, { mode: "split-by-job" })
    const alloy = renderAlloy(plan)
    expect(alloy).toContain('// scrape job: "evil\\nforward_to = []"')
    expect(alloy.split("\n").filter((line) => line.startsWith("forward_to"))).toHaveLength(0)
    const yaml = renderPrometheus(plan)
    expect(yaml.split("\n").filter((line) => line.startsWith("- action"))).toHaveLength(0)
    expect(keys(parsePrometheusRelabel(yaml).rules)).toEqual(keys(rules))
    expect(keys(parseAlloyRelabel(alloy).rules)).toEqual(keys(rules))
  })
})

describe("adaptive metrics merge (2)", () => {
  it("only merges into exact rules and keeps prefix/regex rules", () => {
    const existing = [
      { metric: "req_", match_type: "prefix" as const, drop: true },
      { metric: "req_total", drop_labels: ["a"], aggregations: ["sum"] },
      { metric: "req_.*", match_type: "regex" as const, drop_labels: ["z"] },
    ]
    const result = compileAdaptiveMetrics([dropLabels("req_total", ["pod"], undefined, true)], existing)
    expect(result.rules).toHaveLength(3)
    expect(result.rules.filter((rule) => rule.match_type === "prefix")).toEqual([existing[0]])
    const updated = result.rules.find((rule) => rule.metric === "req_total")
    expect(updated?.drop_labels).toEqual(["a", "pod"])
    expect(updated?.aggregations).toEqual(["sum"])
    expect(result.warnings.filter((warning) => /also matches/.test(warning))).toHaveLength(2)
  })

  it("builds drop rules fresh and never lets rules delete each other", () => {
    const existing = [
      { metric: "m", drop_labels: ["a"], aggregations: ["sum"], aggregation_interval: "1m" },
      { metric: "m", match_type: "prefix" as const, drop_labels: ["b"] },
    ]
    const result = compileAdaptiveMetrics([dropMetric("m")], existing)
    expect(result.rules).toHaveLength(2)
    expect(result.changes[0]).toMatchObject({ type: "update", rule: { metric: "m", drop: true } })
    expect(result.changes[0].rule).toEqual({ metric: "m", drop: true })
  })

  it("derives the API host and omits an empty If-Match", async () => {
    const { adaptiveMetricsBaseUrl, saveAggregationRules } = await loadSources()
    expect(adaptiveMetricsBaseUrl("https://prometheus-prod-01-eu-west-0.grafana.net/api/prom")).toBe(
      "https://prometheus-prod-01-eu-west-0.grafana.net"
    )
    expect(adaptiveMetricsBaseUrl("https://mystack.grafana.net")).toBeNull()
    expect(adaptiveMetricsBaseUrl("http://localhost:9090")).toBeNull()

    const calls: Array<Record<string, string>> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/aggregations/")) calls.push({ ...(init?.headers as Record<string, string>) })
      return new Response(String(url).includes("/aggregations/") ? "[]" : JSON.stringify({ token: "t", expiresAt: "2999-01-01T00:00:00Z" }), { status: 200 })
    }) as typeof fetch
    try {
      const connection: Connection = { baseUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom", mode: "proxy" }
      await saveAggregationRules(connection, [], "")
      await saveAggregationRules(connection, [], "abc")
    } finally {
      globalThis.fetch = original
    }
    expect("If-Match" in calls[0]).toBe(false)
    expect(calls[1]["If-Match"]).toBe("abc")
  })
})

function fakePrometheus(handler: (path: string, params: URLSearchParams) => unknown) {
  const queries: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input))
    queries.push(url.searchParams.get("query") ?? url.pathname)
    const data = handler(url.pathname, url.searchParams)
    if (data instanceof Response) return data
    return new Response(JSON.stringify({ status: "success", data }), { status: 200 })
  }) as typeof fetch
  return { queries, restore: () => (globalThis.fetch = original) }
}

const direct: Connection = { baseUrl: "http://prom:9090", mode: "direct" }

describe("series without a job (3)", () => {
  it("queries and reports the empty job", async () => {
    const { fetchJobDrilldown, fetchSeriesByJob, fetchSnapshot } = await loadSources()
    const fake = fakePrometheus((path) =>
      path.endsWith("/labels")
        ? ["job"]
        : { result: [{ metric: { __name__: "m" }, value: [0, "4"] }] }
    )
    try {
      const drilldown = await fetchJobDrilldown(direct, "")
      expect(fake.queries[0]).toBe('count by (__name__) ({__name__=~".+",job=""})')
      expect(drilldown.metrics[0]).toMatchObject({ job: "", metric: "m", seriesCount: 4 })
      expect((await fetchSeriesByJob(direct, "m"))[0].job).toBe("")
      const snapshot = await fetchSnapshot(direct, 5)
      expect(snapshot.jobs[0].job).toBe("")
    } finally {
      fake.restore()
    }
    expect(normalizeLegacyJob("(no job)")).toBe("")
    expect(normalizeLegacyJob("api")).toBe("api")
  })

  it("compiles and imports rules for series without a job", () => {
    const rules = [dropMetric("m", ""), dropLabels("n", ["pod"], "", false), dropMetric("m")]
    const plan = planRelabel(rules, { mode: "combined" })
    const doc = parse(renderPrometheus(plan)) as { metric_relabel_configs: Array<{ source_labels: string[]; regex: string }> }
    expect(doc.metric_relabel_configs).toContainEqual({ source_labels: ["job", "__name__"], regex: ";(m)", action: "drop" })
    expect(keys(parsePrometheusRelabel(renderPrometheus(plan)).rules)).toEqual(keys(rules))
    expect(keys(parseAlloyRelabel(renderAlloy(plan)).rules)).toEqual(keys(rules))
  })
})

describe("relabel round trip (4, 5, 6)", () => {
  const rules = [
    dropMetric("a_total", "api-server"),
    dropMetric("b_total", "api_server"),
    dropMetric("c_total", "a;m"),
    dropMetric("d_total", ""),
    dropMetric("e_total"),
    dropLabels("f_seconds", ["pod"], "a;m", false),
    dropLabels("g_bytes", ["id", "instance"], "api-server", false),
    dropLabels("h_bytes", ["id"], undefined, false),
  ]

  for (const mode of ["combined", "split-by-job"] as const) {
    it(`is lossless in ${mode} mode`, () => {
      const plan = planRelabel(rules, { mode })
      const prom = parsePrometheusRelabel(renderPrometheus(plan))
      expect(prom.warnings).toEqual([])
      expect(keys(prom.rules)).toEqual(keys(rules))
      const alloy = parseAlloyRelabel(renderAlloy(plan))
      expect(alloy.warnings).toEqual([])
      expect(keys(alloy.rules)).toEqual(keys(rules))
    })
  }

  it("scopes imported rules to their scrape config job", () => {
    const result = parsePrometheusRelabel(`
scrape_configs:
  - job_name: api
    metric_relabel_configs:
      - source_labels: [__name__, pod]
        regex: 'm;.+'
        action: replace
        target_label: pod
        replacement: ''
`)
    expect(keys(result.rules)).toEqual(keys([dropLabels("m", ["pod"], "api")]))
  })

  it("de-duplicates Alloy component labels and keeps job scoping per component", () => {
    const alloy = renderAlloy(planRelabel(rules, { mode: "split-by-job" }))
    const labels = [...alloy.matchAll(/prometheus\.relabel "([^"]+)"/g)].map((match) => match[1])
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain("cardinal_api_server")
    expect(labels).toContain("cardinal_api_server_2")
    expect(alloy).toContain('source_labels = ["job", "__name__"]')
  })

  it("uses a separator that cannot occur in a job containing ;", () => {
    const plan = planRelabel([dropMetric("x", "a;m"), dropLabels("y", ["v"], "a;m", false)], { mode: "combined" })
    const doc = parse(renderPrometheus(plan)) as { metric_relabel_configs: Array<{ separator?: string; regex: string }> }
    expect(doc.metric_relabel_configs[0]).toMatchObject({ separator: ",", regex: "a\\;m,(x)" })
    expect(doc.metric_relabel_configs[1]).toMatchObject({ separator: ",", regex: "a\\;m,y,.+" })
    // Prometheus joins with the separator; a value with ";" in another job cannot match.
    const matches = (config: { regex: string; separator?: string }, values: string[]) =>
      new RegExp(`^(?:${config.regex})$`).test(values.join(config.separator ?? ";"))
    expect(matches(doc.metric_relabel_configs[1], ["a;m", "y", "1"])).toBe(true)
    expect(matches(doc.metric_relabel_configs[1], ["a", "m", "y,1"])).toBe(false)
  })
})

describe("rule keys and merging (7, 8)", () => {
  it("does not collide on : or *", () => {
    expect(ruleKey(dropMetric("b", "a:"))).not.toBe(ruleKey(dropMetric("b", "a")))
    expect(ruleKey(dropMetric("m", "*"))).not.toBe(ruleKey(dropMetric("m")))
    expect(ruleKey(dropMetric("m", ""))).not.toBe(ruleKey(dropMetric("m")))
  })

  it("keeps proposals separate from active and rejected rules", () => {
    const active = dropLabels("m", ["a"])
    const result = mergeRules([active, rejected(dropMetric("n"))], [proposed(dropLabels("m", ["b"])), proposed(dropMetric("n"))])
    expect(result.rules).toHaveLength(4)
    expect(result.rules[0]).toEqual(active)
    expect(result.rules.filter((rule) => rule.status === "proposed")).toHaveLength(2)
    expect(result.added).toHaveLength(2)
  })

  it("skips proposals an active rule already covers", () => {
    const result = mergeRules(
      [dropLabels("m", ["a", "b"]), dropMetric("n")],
      [proposed(dropLabels("m", ["a"])), proposed(dropMetric("n")), proposed(dropLabels("m", ["c"]))]
    )
    expect(result.skipped).toHaveLength(2)
    expect(result.added).toHaveLength(1)
    expect(result.rules).toHaveLength(3)
  })

  it("activates a rejected or proposed rule instead of doing nothing", () => {
    const previous = rejected(dropMetric("m"))
    const rules = activateOrCreate([previous], { kind: "drop_metric", selector: { metric: "m" }, origin: "user" })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ id: previous.id, status: "active" })

    const labels = activateOrCreate([proposed(dropLabels("x", ["a"]))], {
      kind: "drop_labels",
      selector: { metric: "x" },
      labels: ["b"],
      origin: "user",
    })
    expect(labels[0]).toMatchObject({ status: "active", labels: ["a", "b"] })
    expect(activateOrCreate([], { kind: "drop_metric", selector: { metric: "y" }, origin: "user" })[0].status).toBe("active")
  })
})

describe("regex literals and value conditions (9, 10)", () => {
  it("only unescapes punctuation", () => {
    expect(parseLiteralAlternation("foo\\d")).toBeNull()
    expect(parseLiteralAlternation("a\\.b|c\\;d")).toEqual(["a.b", "c;d"])
    const result = parsePrometheusRelabel("- source_labels: [__name__]\n  regex: 'foo\\d'\n  action: drop\n")
    expect(result.rules).toEqual([])
    expect(result.warnings[0]).toMatch(/literal/)
  })

  it("skips replace rules that only clear some label values", () => {
    const result = parsePrometheusRelabel(`
- source_labels: [__name__, env]
  regex: 'm;prod'
  action: replace
  target_label: env
  replacement: ''
- source_labels: [__name__, env]
  regex: 'm;(.*)'
  action: replace
  target_label: env
  replacement: ''
`)
    expect(keys(result.rules)).toEqual(keys([dropLabels("m", ["env"])]))
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/value condition/)
  })
})

describe("savings (11)", () => {
  const snapshot = buildSnapshotFromRows(
    [
      { job: "a", metric: "m", seriesCount: 30 },
      { job: "b", metric: "m", seriesCount: 50 },
      { job: "", metric: "m", seriesCount: 20 },
      { job: "a", metric: "n", seriesCount: 100 },
    ],
    1,
    10
  )

  it("sums job-scoped drops from the snapshot and caps at the metric total", () => {
    const savings = computeExpectedSavings([dropMetric("m", "a"), dropMetric("m", "b")], snapshot, {})
    expect(savings).toMatchObject({ savedSeries: 80, isEstimate: false })
    const all = computeExpectedSavings([dropMetric("m", "a"), dropMetric("m"), dropMetric("m", "")], snapshot, {})
    expect(all.savedSeries).toBe(100)
    const capped = { ...dropLabels("n", ["x"]), impact: { seriesBefore: 500, seriesAfter: 0, exact: true, mergesSeries: true, measuredAt: "" } }
    expect(computeExpectedSavings([capped], snapshot, {}).savedSeries).toBe(100)
  })

  it("skips shadowed label drops and fills impacts from the snapshot", () => {
    const labels = { ...dropLabels("n", ["x"]), impact: { seriesBefore: 100, seriesAfter: 10, exact: true, mergesSeries: true, measuredAt: "" } }
    expect(computeExpectedSavings([labels, dropMetric("n")], snapshot, {}).savedSeries).toBe(100)
    expect(snapshotImpact(dropMetric("m", ""), snapshot)).toMatchObject({ seriesBefore: 20, seriesAfter: 0, exact: true, mergesSeries: false })
    expect(snapshotImpact(dropMetric("m", "zz"), snapshot)?.seriesBefore).toBe(0)
    expect(snapshotImpact(dropLabels("m", ["x"]), snapshot)).toBeNull()
  })

  it("formats deltas without a negative zero", () => {
    expect(formatDelta(-0.2)).toBe("0")
    expect(formatDelta(-0)).toBe("0")
    expect(formatDelta(-1200)).toBe(`−${(1200).toLocaleString()}`)
    expect(formatDelta(3)).toBe("+3")
  })
})

describe("concurrency (12)", () => {
  it("stops pulling work after a failure", async () => {
    const started: number[] = []
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5, 6], async (item) => {
        started.push(item)
        if (item === 1) throw new Error("boom")
        await new Promise((resolve) => setTimeout(resolve, 5))
        return item
      }, 2)
    ).rejects.toThrow("boom")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started.length).toBeLessThanOrEqual(2)
  })

  it("respects an abort signal and a non-finite concurrency", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runWithConcurrency([1], async (item) => item, 2, controller.signal)).rejects.toThrow()
    expect(await runWithConcurrency([1, 2, 3], async (item) => item * 2, Number.NaN)).toEqual([2, 4, 6])
  })
})

describe("promql limits (13)", () => {
  it("falls back to a default topk when the limit is not finite", () => {
    expect(queries.topLabelValues({ metric: "m" }, "pod", Number.NaN)).toMatch(/^topk\(50,/)
    expect(queries.topLabelValues({ metric: "m" }, "pod", Infinity)).toMatch(/^topk\(50,/)
  })
})

describe("snapshot resilience (14)", () => {
  it("tolerates a failing /labels call", async () => {
    const { fetchSnapshot } = await loadSources()
    const fake = fakePrometheus((path) =>
      path.endsWith("/labels")
        ? new Response("nope", { status: 500 })
        : { result: [{ metric: { __name__: "m", job: "a" }, value: [0, "2"] }] }
    )
    try {
      const snapshot = await fetchSnapshot(direct, 5)
      expect(snapshot.labelCount).toBeNull()
      expect(snapshot.totalSeries).toBe(2)
    } finally {
      fake.restore()
    }
  })
})

describe("histogram families (15)", () => {
  it("splits histogram parts and finds family members", () => {
    expect(histogramFamily("rpc_seconds_bucket")).toEqual({ base: "rpc_seconds", part: "bucket" })
    expect(histogramFamily("rpc_seconds_count")).toEqual({ base: "rpc_seconds", part: "count" })
    expect(histogramFamily("up")).toEqual({ base: "up", part: null })
    const snapshot = buildSnapshotFromRows(
      ["rpc_seconds_bucket", "rpc_seconds_sum", "rpc_seconds_count", "up"].map((metric) => ({ job: "a", metric, seriesCount: 1 })),
      null,
      10
    )
    expect(familyMembers("rpc_seconds", snapshot)).toEqual(["rpc_seconds_bucket", "rpc_seconds_sum", "rpc_seconds_count"])
  })
})

describe("series and bucket rules (16)", () => {
  const dropSeries = (metric: string, label: string, regex: string, job?: string) =>
    createRule({ kind: "drop_series", selector: scoped(metric, job), match: { label, regex }, origin: "user" })
  const keepBuckets = (metric: string, buckets: string[], job?: string) =>
    createRule({ kind: "keep_buckets", selector: scoped(metric, job), buckets, origin: "user" })

  it("compiles a series drop to a drop on [__name__, label]", () => {
    const yaml = renderPrometheus(planRelabel([dropSeries("http_requests_total", "path", "/api/users/.+")], { mode: "combined" }))
    expect(parse(yaml)).toEqual({
      metric_relabel_configs: [{ source_labels: ["__name__", "path"], regex: "http_requests_total;(/api/users/.+)", action: "drop" }],
    })
    const scopedYaml = renderPrometheus(planRelabel([dropSeries("m", "path", "a;b|c", "api")], { mode: "combined" }))
    expect(parse(scopedYaml).metric_relabel_configs[0]).toEqual({
      source_labels: ["job", "__name__", "path"],
      regex: "api;m;(a;b|c)",
      action: "drop",
    })
  })

  it("keeps listed buckets with a mark, a drop and a labeldrop, always keeping +Inf", () => {
    const rule = keepBuckets("rpc_seconds_bucket", ["0.5", "0.1"])
    expect(rule.kind === "keep_buckets" && rule.buckets).toEqual(["0.1", "0.5", "+Inf"])
    const configs = parse(renderPrometheus(planRelabel([rule], { mode: "combined" }))).metric_relabel_configs
    expect(configs).toEqual([
      {
        source_labels: ["__name__", "le"],
        regex: "rpc_seconds_bucket;(\\+Inf|0\\.1|0\\.5)",
        action: "replace",
        target_label: "__tmp_cardinal_keep_le",
        replacement: "1",
      },
      { source_labels: ["__name__", "le", "__tmp_cardinal_keep_le"], regex: "rpc_seconds_bucket;.+;", action: "drop" },
      { regex: "__tmp_cardinal_keep_le", action: "labeldrop" },
    ])
    // The drop condition hits exactly the unmarked buckets.
    const drop = new RegExp(`^(?:${configs[1].regex})$`)
    expect(drop.test("rpc_seconds_bucket;0.25;")).toBe(true)
    expect(drop.test("rpc_seconds_bucket;0.1;1")).toBe(false)
    expect(drop.test("rpc_seconds_count;;")).toBe(false)
  })

  it("round-trips series and bucket rules through Prometheus YAML and Alloy", () => {
    const rules = [
      dropSeries("http_requests_total", "path", "/api/users/[0-9]+"),
      dropSeries("m", "uid", ".*-canary", "a,b;c"),
      keepBuckets("rpc_seconds_bucket", ["0.1", "1"]),
      keepBuckets("rpc_seconds_bucket", ["0.25"], "api"),
      dropLabels("n", ["pod"], undefined, false),
    ]
    const expected = keys(rules)
    const withBuckets = (list: Rule[]) =>
      list.map((rule) => (rule.kind === "keep_buckets" ? `${ruleKey(rule)}${rule.buckets}` : rule.kind === "drop_labels" ? `${ruleKey(rule)}[${rule.labels}]` : ruleKey(rule))).sort()
    const plan = planRelabel(rules, { mode: "combined" })
    const fromYaml = parsePrometheusRelabel(renderPrometheus(plan))
    const fromAlloy = parseAlloyRelabel(renderAlloy(plan))
    expect(fromYaml.warnings).toEqual([])
    expect(fromAlloy.warnings).toEqual([])
    expect(keys(fromYaml.rules)).toEqual(expected)
    expect(withBuckets(fromYaml.rules)).toEqual(withBuckets(rules))
    expect(withBuckets(fromAlloy.rules)).toEqual(withBuckets(rules))
    // Split by job keeps every rule's scope.
    const split = planRelabel(rules, { mode: "split-by-job", jobsByMetric: { http_requests_total: ["x"] } })
    expect(parsePrometheusRelabel(renderPrometheus(split)).warnings).toEqual([])
  })

  it("orders series drops before label clears", () => {
    const plan = planRelabel([dropLabels("m", ["path"], undefined, false), dropSeries("m", "path", "/health")], { mode: "combined" })
    expect(plan.sections[0].steps.map((step) => step.kind)).toEqual(["drop_series", "clear_label"])
  })

  it("leaves series and bucket rules out of Adaptive Metrics with a warning", () => {
    const result = compileAdaptiveMetrics([dropSeries("m", "path", "x"), keepBuckets("h_bucket", ["1"])])
    expect(result.rules).toEqual([])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toMatch(/can't be expressed/)
  })

  it("measures with regex matchers and validates patterns", () => {
    expect(queries.seriesMatching({ metric: "m", matchers: { job: "a" } }, "path", "/api/.+")).toBe(
      'count({__name__="m",job="a",path=~"/api/.+"})'
    )
    expect(queries.bucketsOutside({ metric: "h_bucket" }, ["0.1", "+Inf"])).toBe(
      'count({__name__="h_bucket",le=~".+",le!~"\\\\+Inf|0\\\\.1"})'
    )
    expect(() => queries.seriesMatching({ metric: "m" }, "path", "a)|(b")).toThrow(/unbalanced/)
    expect(regexProblem("(?!x).*")).toMatch(/RE2/)
    expect(regexProblem("[)]x")).toBeNull()
    expect(regexProblem("a\nb")).toMatch(/control/)
    expect(regexProblem("/api/users/[0-9]+")).toBeNull()
  })

  it("keys series drops by their pattern and folds bucket keeps to the intersection", () => {
    expect(ruleKey(dropSeries("m", "a", "x"))).not.toBe(ruleKey(dropSeries("m", "a", "y")))
    const { rules } = mergeRules([keepBuckets("h_bucket", ["0.1", "1", "5"])], [keepBuckets("h_bucket", ["1", "5", "10"])])
    expect(rules).toHaveLength(1)
    expect(rules[0].kind === "keep_buckets" && rules[0].buckets).toEqual(["1", "5", "+Inf"])
    const covered = mergeRules([keepBuckets("h_bucket", ["1"])], [keepBuckets("h_bucket", ["1", "5"])])
    expect(covered.skipped).toHaveLength(1)
  })

  it("marks rules made redundant by broader ones as shadowed", () => {
    const global = dropMetric("m")
    const scopedDrop = dropMetric("m", "a")
    expect(shadowedBy(scopedDrop, [global, scopedDrop])).toBe(global)
    expect(isShadowed(global, [global, scopedDrop])).toBe(false)
    expect(isShadowed(dropSeries("m", "x", "y", "a"), [global])).toBe(true)
    const labels = dropLabels("n", ["a", "b"])
    expect(isShadowed(dropLabels("n", ["a"], "job1"), [labels])).toBe(true)
    expect(isShadowed(dropLabels("n", ["a", "c"], "job1"), [labels])).toBe(false)
  })

  it("reads write_relabel_configs from remote_write", () => {
    const text = renderPrometheus(planRelabel([dropMetric("m"), dropSeries("n", "path", "/x")], { mode: "combined" }), "remote_write")
    expect(parse(text).remote_write[0].write_relabel_configs).toHaveLength(2)
    expect(keys(parsePrometheusRelabel(text).rules)).toEqual(keys([dropMetric("m"), dropSeries("n", "path", "/x")]))
  })
})

describe("id-like labels (17)", () => {
  it("classifies single values", () => {
    expect(classifyValue("3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b")).toBe("uuid")
    expect(classifyValue("a3f9c2e81b7d4f60")).toBe("hex")
    expect(classifyValue("1234567")).toBe("numeric")
    expect(classifyValue("/api/users/12345/orders")).toBe("path")
    expect(classifyValue("https://x.io/v1/items/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b")).toBe("path")
    expect(classifyValue("10.0.3.17:9100")).toBe("ip")
    expect(classifyValue("fe80::1ff:fe23:4567:890a")).toBe("ip")
    expect(classifyValue("jane@example.com")).toBe("email")
    for (const name of ["GET", "200", "/api/users", "us-east-1", "checkout-service", "deadbeef", "0.005", "+Inf"]) {
      expect(classifyValue(name), name).toBeNull()
    }
  })

  it("flags a label only when most top values look like IDs", () => {
    const uuids = ["3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", "4a2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0c", "5b2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0d"]
    expect(detectIdLike(uuids)).toMatchObject({ kind: "uuid", share: 1 })
    expect(detectIdLike([...uuids, "a", "b", "c", "d"])).toBeNull()
    expect(detectIdLike(uuids.slice(0, 2))).toBeNull()
    expect(detectIdLike(["GET", "POST", "PUT"])).toBeNull()
  })

  it("generalises ID segments of a path into a pattern", () => {
    expect(generalizePath("/api/users/12345/orders")).toBe("/api/users/[^/]+/orders")
    expect(generalizePath("/v1.2/items/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b?x=1")).toBe("/v1\\.2/items/[^/]+.*")
    expect(generalizePath("/api/users")).toBeNull()
  })
})

describe("rule set sharing (18)", () => {
  it("round-trips through a URL hash as proposals", () => {
    const rules = [
      { ...dropMetric("m", ""), rationale: "unused\nsecond line" },
      dropLabels("n", ["pod"]),
      createRule({ kind: "drop_series", selector: { metric: "h" }, match: { label: "path", regex: "/ü/.+" }, origin: "user" }),
      createRule({ kind: "keep_buckets", selector: { metric: "h_bucket", job: "a" }, buckets: ["0.1"], origin: "user" }),
    ]
    const hash = shareHash(rules)
    expect(hash).toMatch(/^#rules=[A-Za-z0-9_-]+$/)
    const read = readShareHash(hash)!
    expect(read.warnings).toEqual([])
    expect(keys(read.rules)).toEqual(keys(rules))
    expect(read.rules.every((rule) => rule.status === "proposed" && rule.origin === "import")).toBe(true)
    expect(read.rules[0].rationale).toBe("unused second line")
    expect(readShareHash("#other=1")).toBeNull()
  })

  it("refuses malformed rules and payloads", () => {
    const bad = parseRuleSetJson(
      JSON.stringify({
        format: "cardinal.rules",
        version: 1,
        rules: [
          { kind: "drop_metric", metric: "bad name" },
          { kind: "drop_series", metric: "m", match: { label: "x", regex: "a)|(b" } },
          { kind: "keep_buckets", metric: "m", buckets: ["1; drop"] },
          { kind: "drop_labels", metric: "m", labels: ["ok"] },
          { kind: "evil", metric: "m" },
        ],
      })
    )
    expect(bad.rules).toHaveLength(1)
    expect(bad.warnings).toHaveLength(4)
    expect(() => parseRuleSetJson('{"format":"x"}')).toThrow(/Not a Cardinal/)
    expect(() => base64UrlDecode("not base64!")).toThrow()
    expect(base64UrlDecode(base64UrlEncode("héllo ✓"))).toBe("héllo ✓")
  })
})

describe("export reports (19)", () => {
  it("diffs active rules against the imported baseline", () => {
    const imported = [dropMetric("a"), dropLabels("b", ["pod"])]
    const baseline = updateBaseline([], imported, "merge")
    const current = [dropMetric("a"), dropLabels("b", ["pod", "uid"]), dropMetric("c")]
    const diff = diffAgainstBaseline(baseline, current)
    expect(diff.unchanged.map((rule) => rule.selector.metric)).toEqual(["a"])
    expect(diff.changed.map((item) => item.before)).toEqual([["pod"]])
    expect(diff.added.map((rule) => rule.selector.metric)).toEqual(["c"])
    expect(diffAgainstBaseline(baseline, [dropMetric("c")]).removed).toHaveLength(2)
    expect(updateBaseline(baseline, [dropMetric("z")], "replace")).toHaveLength(1)
  })

  it("writes one-line comments even when rationales contain newlines", () => {
    const rule = { ...dropMetric("m"), rationale: "line one\nmetric_relabel_configs: []" }
    rule.impact = { seriesBefore: 1200, seriesAfter: 0, exact: true, mergesSeries: false, measuredAt: "" }
    const header = renderHeader([rule], { generatedAt: new Date("2026-09-26T10:00:00Z"), totalSeries: 10_000, savedSeries: 1200, isEstimate: false }, "#")
    expect(header.split("\n").filter(Boolean).every((line) => line.startsWith("#"))).toBe(true)
    expect(header).toContain("Generated by Cardinal on 2026-09-26 10:00 UTC.")
    expect(header).toContain("Why: line one metric_relabel_configs: []")
    expect(parse(`${header}metric_relabel_configs: []`)).toEqual({ metric_relabel_configs: [] })
  })

  it("builds a PR description with a rules table", () => {
    const rule = { ...dropLabels("m", ["pod"]), rationale: "pod | churn" }
    rule.impact = { seriesBefore: 3000, seriesAfter: 1000, exact: true, mergesSeries: false, measuredAt: "" }
    const md = prDescription([rule, dropMetric("n")], {
      generatedAt: new Date("2026-09-26T10:00:00Z"),
      totalSeries: 10_000,
      savedSeries: 2000,
      isEstimate: true,
      cost: (series) => (series / 1000) * 8,
      formatCost: (amount) => `$${amount.toFixed(2)}`,
      usage: { m: "2 alerts" },
      target: "Prometheus",
    })
    expect(md).toContain("| Rule | Scope | Series saved | Cost / month | Usage evidence |")
    expect(md).toContain(`| Drop label \`pod\` from \`m\` | all jobs | −${(2000).toLocaleString()} | $16.00 | 2 alerts |`)
    expect(md).toContain("| Drop metric `n` | all jobs | not measured | – | not checked |")
    expect(md).toContain("pod | churn")
    expect(md).toContain(`~${(2000).toLocaleString()} active series`)
  })
})

describe("adaptive apply diff and revert (20)", () => {
  it("describes each change before and after", () => {
    const result = compileAdaptiveMetrics([dropLabels("a_total", ["pod"]), dropMetric("b")], [{ metric: "a_total", drop_labels: ["uid"], aggregations: ["sum"] }])
    const diffs = adaptiveChangeDiffs(result.changes)
    expect(diffs.find((diff) => diff.metric === "a_total")).toMatchObject({
      type: "update",
      before: "drop labels uid · aggregate with sum",
      after: "drop labels pod, uid · aggregate with sum",
      addedLabels: ["pod"],
      aggregations: ["sum"],
    })
    expect(diffs.find((diff) => diff.metric === "b")).toMatchObject({ type: "add", before: null, after: "drop the metric" })
  })

  it("reverts only while the remote rules are still what was applied", () => {
    const previous = [{ metric: "a", drop_labels: ["x"], aggregations: ["sum"] }]
    const applied = [{ metric: "a", drop_labels: ["y", "x"], aggregations: ["sum"] }, { metric: "b", drop: true }]
    const backup = { appliedAt: "", previous, previousEtag: "e1", applied, changes: 2 }
    const reordered = [{ metric: "b", drop: true, match_type: "" as const }, { metric: "a", drop_labels: ["x", "y"], aggregations: ["sum"] }]
    expect(planRevert(backup, reordered, "e2")).toEqual({ ok: true, rules: previous, etag: "e2" })
    expect(planRevert(backup, [...reordered, { metric: "c", drop: true }], "e3")).toMatchObject({ ok: false })
    expect(planRevert(null, [], "")).toMatchObject({ ok: false })
  })
})

describe("usage gate (21)", () => {
  it("names what was found and what wasn't checked", () => {
    const none = summarizeEvidence({ rules: [], cloud: false, cloudUsage: null })
    expect(none.used).toBe(false)
    expect(none.found).toEqual([])
    expect(none.unchecked.join(" ")).toMatch(/Grafana Cloud connection/)
    const cloud = summarizeEvidence({
      rules: [{ group: "g", name: "HighLatency", type: "alerting" }],
      cloud: true,
      cloudUsage: { dashboards: 3, queries: 1, rules: 0 },
    })
    expect(cloud.used).toBe(true)
    expect(cloud.badge).toBe("1 alert · 3 dashboards · 1 query")
    expect(cloud.unchecked).toEqual(["Dashboards outside Grafana Cloud weren't checked."])
    const failed = summarizeEvidence({ rules: null, rulesError: "404", cloud: false, cloudUsage: null })
    expect(failed.unchecked[0]).toMatch(/couldn't be read \(404\)/)
    const unusedLabel = summarizeEvidence({ rules: [], cloud: true, cloudUsage: { dashboards: 2, queries: 0, rules: 0, droppedLabels: ["pod"] } }, "pod")
    expect(unusedLabel.used).toBe(false)
    expect(guardedLabel("le")?.reason).toMatch(/histogram_quantile/)
    expect(guardedLabel("pod")).toBeUndefined()
    expect(confirmationKey("m", undefined)).not.toBe(confirmationKey("m", ""))
  })

  it("warns that dropping buckets orphans _sum and _count", () => {
    const snapshot = buildSnapshotFromRows(
      ["rpc_seconds_bucket", "rpc_seconds_sum", "rpc_seconds_count"].map((metric) => ({ job: "a", metric, seriesCount: 1 })),
      null,
      10
    )
    expect(orphanWarning("rpc_seconds_bucket", snapshot)).toEqual({
      base: "rpc_seconds",
      orphans: ["rpc_seconds_sum", "rpc_seconds_count"],
      members: ["rpc_seconds_bucket", "rpc_seconds_sum", "rpc_seconds_count"],
    })
    expect(orphanWarning("rpc_seconds_sum", snapshot)).toBeNull()
  })

  it("limits concurrent work", async () => {
    const run = createLimiter(2)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        run(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
        })
      )
    )
    expect(peak).toBe(2)
  })
})

describe("churn", () => {
  const loadChurn = () => import("@/lib/core/churn")
  interface ChurnSources {
    churnQueries: {
      seenByJobAndMetric(window: string): string
      seenByMetricForJob(job: string, window: string): string
      labelValuesSeen(sel: { metric: string; matchers?: Record<string, string> }, label: string, window: string): string
    }
    fetchChurn(connection: Connection, window: string): Promise<{ method: string; creationRate: number | null; rows: unknown[]; summary: { churned: number } }>
    fetchLabelDrivers(
      connection: Connection,
      metric: string,
      window: string,
      options: { job?: string }
    ): Promise<{ driver?: { label: string }; labels: Array<{ label: string }>; seriesSeen: number; seriesNow: number; skippedLabels: string[] }>
  }
  const churnSourcePath = "@/lib/sources/churn"
  const row = (job: string, metric: string, seriesCount: number) => ({ job, metric, seriesCount })

  it("merges seen and active rows, clamps churn at 0 and flags high ratios", async () => {
    const churn = await loadChurn()
    const rows = churn.mergeChurn(
      [row("cadvisor", "container_tasks_state", 245), row("node", "up", 1), row("api", "gone_total", 4), row("api", "late", 2)],
      [row("cadvisor", "container_tasks_state", 220), row("node", "up", 1), row("api", "late", 3), row("api", "new_only", 5)]
    )
    const by = (metric: string) => rows.find((item) => item.metric === metric)!
    expect(by("container_tasks_state")).toMatchObject({ seen: 245, active: 220, churned: 25, high: false })
    expect(by("container_tasks_state").ratio).toBeCloseTo(245 / 220)
    expect(by("up")).toMatchObject({ churned: 0, ratio: 1, high: false })
    expect(by("gone_total")).toMatchObject({ active: 0, churned: 4, ratio: null, high: true })
    // Active counted after the seen query: never negative churn.
    expect(by("late")).toMatchObject({ seen: 3, active: 3, churned: 0 })
    expect(rows.some((item) => item.metric === "new_only")).toBe(false)
    expect(churn.isHighChurn({ churned: 3, ratio: 2 })).toBe(true)
    expect(churn.isHighChurn({ churned: 3, ratio: 1.5 })).toBe(false)
  })

  it("ranks by churned series and summarises", async () => {
    const churn = await loadChurn()
    const rows = churn.mergeChurn(
      [row("a", "m1", 10), row("a", "m2", 40), row("b", "m1", 4), row("b", "m3", 5)],
      [row("a", "m1", 5), row("a", "m2", 25), row("b", "m1", 4), row("b", "m3", 0)]
    )
    expect(churn.rankChurn(rows).map((item) => `${item.job}/${item.metric}`)).toEqual(["a/m2", "b/m3", "a/m1"])
    expect(churn.rankChurn(rows, 1)).toHaveLength(1)
    expect(churn.summarizeChurn(rows)).toEqual({ seen: 59, active: 34, churned: 25, churnPercent: (25 / 34) * 100, churningPairs: 3, highPairs: 3 })
    expect(churn.summarizeChurn([]).churnPercent).toBe(0)
    expect(churn.activeRowsFromTable({ m: { a: 2, "": 1 } })).toEqual([row("a", "m", 2), row("", "m", 1)])
  })

  it("finds the label driving churn", async () => {
    const churn = await loadChurn()
    const labels = churn.rankLabelDrivers([
      { label: "__name__", seen: 1, now: 1 },
      { label: "instance", seen: 1, now: 1 },
      { label: "id", seen: 60, now: 40 },
      { label: "name", seen: 25, now: 20 },
    ])
    expect(labels.map((item) => item.label)).toEqual(["id", "name", "instance"])
    expect(churn.churnDriver(labels)).toMatchObject({ label: "id", jump: 20 })
    expect(churn.churnDriver(churn.rankLabelDrivers([{ label: "a", seen: 2, now: 2 }]))).toBeUndefined()
  })

  it("prices churn only with a price and hedges the note", async () => {
    const churn = await loadChurn()
    expect(churn.churnCost(2500, 8).monthly).toBe(20)
    expect(churn.churnCost(-5, 8).monthly).toBe(0)
    expect(churn.churnCost(100, undefined).monthly).toBeNull()
    expect(churn.churnCost(100, 0).monthly).toBeNull()
    expect(churn.churnCost(100, 8).note).toMatch(/rough indication, not an invoice/)
  })

  it("builds safe queries and falls back to per-job counting on a query limit", async () => {
    const { churnQueries, fetchChurn, fetchLabelDrivers } = (await import(/* @vite-ignore */ churnSourcePath)) as ChurnSources
    expect(churnQueries.seenByJobAndMetric("6h")).toBe('count by (job, __name__) (last_over_time({__name__=~".+"}[6h]))')
    expect(churnQueries.seenByMetricForJob('a"b', "1h")).toBe('count by (__name__) (last_over_time({__name__=~".+",job="a\\"b"}[1h]))')
    expect(churnQueries.labelValuesSeen({ metric: "m", matchers: { job: "x" } }, "pod", "24h")).toBe(
      'count(count by (pod) (last_over_time({__name__="m",job="x"}[24h])))'
    )
    expect(() => churnQueries.seenByJobAndMetric("1h] or vector(1) #")).toThrow(/Invalid churn window/)
    expect(() => churnQueries.labelValuesSeen({ metric: "m" }, "a)", "1h")).toThrow(/Invalid label/)

    const fake = fakePrometheus((path, params) => {
      const query = params.get("query") ?? ""
      if (path.endsWith("/label/job/values")) return ["api"]
      if (query.includes("prometheus_tsdb_head_series_created_total")) return { result: [] }
      if (query.startsWith("count by (job, __name__)")) return new Response("exceeded maximum series", { status: 422 })
      if (query.includes('job=""')) return { result: [] }
      const seen = query.includes("last_over_time")
      return { result: [{ metric: { __name__: "m" }, value: [0, seen ? "12" : "4"] }] }
    })
    try {
      const result = await fetchChurn(direct, "1h")
      expect(result.method).toBe("per-job")
      expect(result.creationRate).toBeNull()
      expect(result.rows).toEqual([{ job: "api", metric: "m", seen: 12, active: 4, churned: 8, ratio: 3, high: true }])
      expect(result.summary.churned).toBe(8)
    } finally {
      fake.restore()
    }

    const labelsFake = fakePrometheus((path, params) => {
      const query = params.get("query") ?? ""
      if (path.endsWith("/labels")) return ["__name__", "job", "pod", "instance"]
      const value = query.includes("by (pod)") ? (query.includes("last_over_time") ? "30" : "10") : query.includes("last_over_time(") && !query.includes("by (") ? "30" : "10"
      return { result: [{ metric: {}, value: [0, query.includes("by (instance)") ? "1" : value] }] }
    })
    try {
      const drivers = await fetchLabelDrivers(direct, "m", "1h", { job: "api" })
      expect(drivers.driver?.label).toBe("pod")
      expect(drivers.labels.map((item) => item.label)).toEqual(["pod", "instance"])
      expect(drivers).toMatchObject({ seriesSeen: 30, seriesNow: 10, skippedLabels: [] })
    } finally {
      labelsFake.restore()
    }
  })
})

describe("signals and legacy routes", () => {
  it("reads the signal from the path", () => {
    expect(signalFromPath("/metrics")).toBe("metrics")
    expect(signalFromPath("/metrics/explore/up")).toBe("metrics")
    expect(signalFromPath("/logs/streams")).toBe("logs")
    expect(signalFromPath("/metricsx")).toBeNull()
    expect(signalFromPath("/rules")).toBeNull()
  })

  it("enters a signal at its last page, or its overview", () => {
    expect(signalEntry("logs", {})).toBe("/logs")
    expect(signalEntry("metrics", { metrics: "/metrics/jobs?q=a" })).toBe("/metrics/jobs?q=a")
    // A stale entry that doesn't belong to the signal is ignored.
    expect(signalEntry("logs", { logs: "/rules" })).toBe("/logs")
  })

  it("redirects pre-restructure URLs and keeps the query", () => {
    expect(legacyRedirect("/", "", "logs")).toBe("/logs")
    expect(legacyRedirect("/", "?x=1", "metrics")).toBe("/metrics?x=1")
    expect(legacyRedirect("/jobs", "?sort=a", "metrics")).toBe("/metrics/jobs?sort=a")
    expect(legacyRedirect("/jobs/kube%2Fapi/x", "", "logs")).toBe("/metrics/jobs/kube%2Fapi/x")
    expect(legacyRedirect("/churn", "?window=1h", "metrics")).toBe("/metrics/churn?window=1h")
    expect(legacyRedirect("/histograms/", "", "metrics")).toBe("/metrics/histograms")
    expect(legacyRedirect("/adaptive", "", "metrics")).toBe("/rules?view=recommendations")
    expect(legacyRedirect("/adaptive", "?tab=proposed", "metrics")).toBe("/rules?tab=proposed&view=recommendations")
    expect(legacyRedirect("/teams", "", "metrics")).toBe("/attribution")
    expect(legacyRedirect("/metrics/http_requests_total", "?label=le", "metrics")).toBe("/metrics/explore/http_requests_total?label=le")
  })

  it("leaves current routes alone", () => {
    expect(legacyRedirect("/metrics/explore", "", "metrics")).toBeNull()
    expect(legacyRedirect("/metrics/jobs", "", "metrics")).toBeNull()
    expect(legacyRedirect("/metrics/explore/up", "", "metrics")).toBeNull()
    expect(legacyRedirect("/rules", "", "metrics")).toBeNull()
    expect(legacyRedirect("/nope", "", "metrics")).toBeNull()
  })
})
