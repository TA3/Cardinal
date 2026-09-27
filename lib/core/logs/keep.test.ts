import { describe, expect, it } from "vitest"

import { exemptionToKeepRule, planExemptions } from "@/lib/core/logs/adaptive-apply"
import { compileAdaptiveLogs } from "@/lib/core/logs/compile/adaptive-logs"
import { compileAlloyLogs } from "@/lib/core/logs/compile/alloy"
import { compilePromtailLogs } from "@/lib/core/logs/compile/promtail"
import { computeLogSavings, keptSavings } from "@/lib/core/logs/impact"
import { excludeKeeps, keepMarker, readKeepMarkers } from "@/lib/core/logs/keep"
import { parseAlloyLogs } from "@/lib/core/logs/parse/alloy"
import { parsePromtailLogs } from "@/lib/core/logs/parse/promtail"
import {
  createLogRule,
  describeLogRule,
  logRuleKey,
  logRuleProblem,
  logRuleProtectedBy,
  logRuleShadowedBy,
  mergeLogRules,
  migrateKeepHacks,
  type LogRuleInput,
} from "@/lib/core/logs/rules"
import { fromLogRuleSet, toLogRuleSet } from "@/lib/core/logs/share"
import type { KeepRule, LabelMatcher, LogRule, LogRuleImpact, LogsSnapshot } from "@/lib/core/logs/types"

const m = (label: string, value: string, op: LabelMatcher["op"] = "="): LabelMatcher => ({ label, op, value })
const api = { matchers: [m("service_name", "api")] }

function rule(input: Partial<LogRuleInput> & Pick<LogRuleInput, "kind">, impact?: Partial<LogRuleImpact>): LogRule {
  const created = createLogRule({ selector: api, origin: "user", ...input } as LogRuleInput)
  return impact ? { ...created, impact: { bytesBefore: 0, bytesAfter: 0, exact: true, measuredAt: "2026-09-26T00:00:00Z", ...impact } } : created
}

const keep = (input: Partial<Omit<KeepRule, "kind">> = {}, impact?: Partial<LogRuleImpact>) =>
  rule({ kind: "keep", rationale: "audit trail", ...input }, impact) as KeepRule

describe("keep rules", () => {
  it("need a rationale, and a selector unless they keep only some lines", () => {
    expect(logRuleProblem({ kind: "keep", selector: api, origin: "user" })).toMatch(/rationale/)
    expect(logRuleProblem({ kind: "keep", selector: api, origin: "user", rationale: "  " })).toMatch(/rationale/)
    expect(logRuleProblem({ kind: "keep", selector: { matchers: [] }, origin: "user", rationale: "x" })).toMatch(/selector/)
    expect(logRuleProblem({ kind: "keep", selector: { matchers: [] }, line: { regex: "audit" }, origin: "user", rationale: "x" })).toBeNull()
    expect(logRuleProblem({ kind: "keep", selector: api, origin: "user", rationale: "x".repeat(501) })).toMatch(/500/)
  })

  it("are keyed by selector and line, and described as protection", () => {
    expect(logRuleKey(keep())).not.toBe(logRuleKey(keep({ line: { regex: "a" } })))
    expect(logRuleKey(keep({ line: { levels: ["ERROR"] } }))).toBe(logRuleKey(keep({ line: { levels: ["error"] } })))
    expect(describeLogRule(keep({ line: { levels: ["error"] } }))).toBe('Protect error lines in {service_name="api"} from drops')
    const { added, skipped } = mergeLogRules([keep()], [keep({ rationale: "again" })])
    expect([added.length, skipped.length]).toEqual([0, 1])
  })

  it("protect drops entirely only when they keep every line of a containing selector", () => {
    const drop = rule({ kind: "drop_streams", selector: { matchers: [m("service_name", "api"), m("pod", "a")] } })
    const all = keep()
    const some = keep({ line: { regex: "audit" } })
    expect(logRuleProtectedBy(drop, [drop, all])).toBe(all)
    expect(logRuleProtectedBy(drop, [drop, some])).toBeUndefined()
    // A narrower keep is redundant next to a broader one of every line.
    expect(logRuleShadowedBy(keep({ selector: drop.selector }), [all])).toBe(all)
  })

  it("replace the rejected drop_lines the Patterns page used to file for Keep", () => {
    const hack = { ...rule({ kind: "drop_lines", line: { regex: "^GET" }, rationale: 'Kept on purpose: pattern "GET <_>" is exempt from drops.' }), status: "rejected" as const }
    const other = { ...rule({ kind: "drop_lines", line: { regex: "x" }, rationale: "noise" }), status: "rejected" as const }
    const [migrated, untouched] = migrateKeepHacks([hack, other])
    expect(migrated).toMatchObject({ id: hack.id, kind: "keep", status: "active", line: { regex: "^GET" }, rationale: hack.rationale })
    expect(untouched).toBe(other)
  })

  it("come from exemptions and plan the ones Grafana Cloud lacks", () => {
    expect(exemptionToKeepRule({ stream_selector: '{service_name="login"}', reason: "audit", active_interval: "24h" })).toMatchObject({
      kind: "keep",
      status: "proposed",
      rationale: "audit (proposed as a 24h exemption)",
    })
    expect(exemptionToKeepRule({ stream_selector: '{a="b"} |= "x"' })).toBeNull()
    const plan = planExemptions(
      [{ stream_selector: '{b="2", a="1"}' }, { stream_selector: '{c="3"}' }, { stream_selector: '{c="3"}' }],
      [{ id: "e1", stream_selector: '{a="1",b="2"}' }]
    )
    expect(plan.create.map((item) => item.stream_selector)).toEqual(['{c="3"}'])
    expect(plan.present).toHaveLength(2)
  })

  it("survive share links", () => {
    const parsed = fromLogRuleSet(toLogRuleSet([keep({ line: { regex: "audit" } })]))
    expect(parsed.rules[0]).toMatchObject({ kind: "keep", line: { regex: "audit" }, rationale: "audit trail", status: "proposed" })
  })
})

describe("excluding kept lines from drops", () => {
  const drop = rule({ kind: "drop_streams" })

  it("adds a negative line filter for a keep of the same or broader streams", () => {
    const result = excludeKeeps(drop, [keep({ line: { regex: "audit" } }), keep({ selector: { matchers: [m("env", "prod")] }, line: { levels: ["error"] } })])
    expect(result.selector).toEqual(api)
    expect(result.exclude).toEqual([{ regex: "audit" }])
    expect(result.unexpressed).toHaveLength(1)
  })

  it("negates the one extra matcher of a narrower keep of whole streams", () => {
    const result = excludeKeeps(drop, [keep({ selector: { matchers: [m("service_name", "api"), m("level", "error")] } })])
    expect(result.selector?.matchers).toContainEqual(m("level", "error", "!="))
    expect(result.unexpressed).toEqual([])
  })

  it("reports keeps it can't express and ignores disjoint ones", () => {
    const two = keep({ selector: { matchers: [m("service_name", "api"), m("a", "1"), m("b", "2")] } })
    const lines = keep({ selector: { matchers: [m("service_name", "api"), m("a", "1")] }, line: { regex: "x" } })
    const other = keep({ selector: { matchers: [m("service_name", "web")] } })
    const result = excludeKeeps(drop, [two, lines, other])
    expect(result.unexpressed).toEqual([two, lines])
    expect(result.applied).toEqual([])
    // An unscoped drop has no match to put a line filter on.
    expect(excludeKeeps({ selector: { matchers: [] } }, [keep({ line: { regex: "x" } })]).unexpressed).toHaveLength(1)
  })

  it("writes and reads keep markers", () => {
    const marker = keepMarker(keep({ line: { regex: 'a"b' }, rationale: "why\nnot" }))
    expect(marker).toBe('cardinal:keep {service_name="api"} |~ "a\\"b" why: why not')
    expect(readKeepMarkers(`  // ${marker}\n# cardinal:keep {} |~ "x" why: all`).keeps).toEqual([
      { selector: api, line: { regex: 'a"b' }, rationale: "why not" },
      { selector: { matchers: [] }, line: { regex: "x" }, rationale: "all" },
    ])
    expect(readKeepMarkers("// cardinal:keep nope").warnings).toHaveLength(1)
  })

  it("protects a drop of the very lines a keep keeps", () => {
    const line = { regex: "audit" }
    expect(excludeKeeps({ selector: api, line }, [keep({ line })]).selector).toBeNull()
    const lines = rule({ kind: "drop_lines", line })
    expect(logRuleProtectedBy(lines, [lines, keep({ line })])).toBeDefined()
    expect(keptSavings(api, 1000, 500, [keep({ line }, { bytesBefore: 1, bytesAfter: 1 })], line)).toEqual({ bytes: 500, estimate: false })
  })
})

describe("keep rules in exports", () => {
  const rules = [
    rule({ kind: "drop_streams" }),
    rule({ kind: "drop_lines", selector: { matchers: [m("service_name", "web")] }, line: { levels: ["debug"] } }),
    rule({ kind: "sample", selector: { matchers: [m("service_name", "shop")] }, keep: 0.1 }),
    keep({ line: { regex: "audit" } }),
    keep({ selector: { matchers: [m("service_name", "web"), m("team", "sec")] } }),
    keep({ selector: { matchers: [m("service_name", "shop"), m("a", "1"), m("b", "2")] } }),
  ]

  it("narrows Alloy stages and round-trips the keeps", () => {
    const { text, warnings } = compileAlloyLogs(rules, { now: new Date("2026-09-26T00:00:00Z") })
    expect(text).toContain('selector            = "{service_name=\\"api\\"} !~ \\"audit\\""')
    expect(text).toContain('selector = "{service_name=\\"web\\", team!=\\"sec\\"}"')
    expect(text).toContain('// cardinal:keep {service_name="api"} |~ "audit" why: audit trail')
    expect(warnings.join(" ")).toMatch(/Sample 10%|Keep 10%/)
    expect(warnings.join(" ")).toMatch(/can't exclude/)
    const back = parseAlloyLogs(text)
    const kinds = back.rules.map((item) => item.kind).sort()
    expect(kinds).toEqual(["drop_lines", "drop_streams", "keep", "keep", "keep", "sample"])
    expect(back.rules.find((item) => item.kind === "keep" && item.line)).toMatchObject({ rationale: "audit trail", line: { regex: "audit" } })
  })

  it("narrows Promtail stages the same way", () => {
    const { text } = compilePromtailLogs(rules)
    expect(text).toContain(`selector: '{service_name="api"} !~ "audit"'`)
    expect(text).toContain("# cardinal:keep")
    expect(parsePromtailLogs(text).rules.filter((item) => item.kind === "keep")).toHaveLength(3)
  })

  it("skips drops a keep protects entirely", () => {
    const { text, warnings } = compileAlloyLogs([rule({ kind: "drop_streams" }), keep()])
    expect(text).toContain("No log rules")
    expect(warnings[0]).toMatch(/protects every line/)
  })

  it("become Adaptive Logs exemptions", () => {
    const { exemptions, warnings, text } = compileAdaptiveLogs(rules)
    expect(exemptions).toEqual([
      { stream_selector: '{service_name="api"}', reason: "audit trail" },
      { stream_selector: '{service_name="web", team="sec"}', reason: "audit trail" },
      { stream_selector: '{a="1", b="2", service_name="shop"}', reason: "audit trail" },
    ])
    expect(warnings.join(" ")).toMatch(/exemptions select streams, not lines/)
    expect(warnings.join(" ")).toMatch(/overlaps keep rule/)
    expect(JSON.parse(text).exemptions).toHaveLength(3)
  })
})

describe("keep rules in savings", () => {
  const snapshot: LogsSnapshot = {
    capturedAt: "2026-09-26T00:00:00Z",
    host: "loki",
    range: "24h",
    totals: { streams: 100, bytes: 10_000, labelCount: 3 },
    groupLabel: "service_name",
    groups: [],
    labels: [],
  }

  it("take back the kept bytes from overlapping drops", () => {
    const drop = rule({ kind: "drop_streams" }, { bytesBefore: 1000, bytesAfter: 0, streamsBefore: 10, streamsAfter: 0 })
    expect(computeLogSavings([drop], snapshot).savedBytes).toBe(1000)
    const kept = keep({ line: { regex: "audit" } }, { bytesBefore: 200, bytesAfter: 200 })
    const savings = computeLogSavings([drop, kept], snapshot)
    expect(savings.savedBytes).toBe(800)
    expect(savings.savedStreams).toBe(0)
    expect(computeLogSavings([drop, keep({}, { bytesBefore: 1000, bytesAfter: 1000 })], snapshot).savedBytes).toBe(0)
  })

  it("scale by the drop's rate and mark partial overlaps as estimates", () => {
    expect(keptSavings(api, 1000, 500, [keep({ line: { regex: "a" } }, { bytesBefore: 200, bytesAfter: 200 })])).toEqual({ bytes: 100, estimate: true })
    const broad = keep({ selector: { matchers: [m("team", "x")] } }, { bytesBefore: 5000, bytesAfter: 5000 })
    expect(keptSavings(api, 1000, 1000, [broad])).toEqual({ bytes: 1000, estimate: true })
    expect(keptSavings(api, 1000, 1000, [keep({ selector: { matchers: [m("service_name", "web")] } })])).toEqual({ bytes: 0, estimate: false })
  })
})
