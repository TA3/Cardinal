import { describe, expect, it } from "vitest"

import { buildLogsPlan } from "@/lib/core/logs/cut-plan"
import { patternLineFilter } from "@/lib/core/logs/patterns"
import { createLogRule } from "@/lib/core/logs/rules"
import { buildServiceWork } from "@/lib/core/logs/service-work"
import type { LogsSnapshot } from "@/lib/core/logs/types"

const selector = { matchers: [{ label: "service_name", op: "=" as const, value: "api" }] }
const patterns = [
  { pattern: "GET /health <_> 200", level: "info", lineShare: 0.5, bytesPerDay: 500 },
  { pattern: "debug cache miss <_>", level: "debug", lineShare: 0.2, bytesPerDay: 200 },
  { pattern: "user <_> logged in", level: "info", lineShare: 0.2, bytesPerDay: 200 },
  { pattern: "payment <_> failed", level: "error", lineShare: 0.1, bytesPerDay: 100 },
]
const line = (pattern: string) => patternLineFilter(pattern)!

describe("service work", () => {
  it("marks patterns dropped, sampled, protected or kept from the service's own rules", () => {
    const rules = [
      createLogRule({ kind: "sample", selector, line: line(patterns[0].pattern), keep: 0.1, origin: "user" }),
      createLogRule({ kind: "drop_lines", selector, line: { levels: ["debug", "trace"] }, origin: "user" }),
      createLogRule({ kind: "keep", selector, line: line(patterns[3].pattern), rationale: "audit trail", origin: "user" }),
      // Another service's rule changes nothing here.
      createLogRule({ kind: "drop_lines", selector: { matchers: [{ label: "service_name", op: "=", value: "web" }] }, line: line(patterns[2].pattern), origin: "user" }),
    ]
    const work = buildServiceWork({ selector, patterns, rules, kept: [patterns[2].pattern], bytesPerDay: 1000 })
    expect(work.patterns.map((item) => item.state)).toEqual(["sampled", "dropped", "kept", "protected"])
    expect(work.done).toBe(4)
    expect(work.savedBytesPerDay).toBe(650)
  })

  it("lets a rule on every line decide every pattern and count the whole service", () => {
    const rules = [createLogRule({ kind: "drop_streams", selector, origin: "user" })]
    const work = buildServiceWork({ selector, patterns, rules, kept: [], bytesPerDay: 1200 })
    expect(new Set(work.patterns.map((item) => item.state))).toEqual(new Set(["dropped"]))
    expect(work.savedBytesPerDay).toBe(1200)
  })

  it("groups the logs plan by service, label moves last", () => {
    const snapshot = {
      range: "24h",
      totals: { streams: 10, bytes: 3000, labelCount: 3 },
      groups: [
        { value: "api", streams: 4, bytes: 2000, share: 66.7 },
        { value: "web", streams: 6, bytes: 1000, share: 33.3 },
      ],
    } as Pick<LogsSnapshot, "groups" | "range" | "totals">
    const risk = { level: "safe" as const, confidence: 1, why: [] }
    const base = { estimate: true, risk, rule: { kind: "drop_streams" as const, selector, origin: "user" as const } }
    const plans = buildLogsPlan(snapshot, [
      { ...base, id: "a", reason: "labels", title: "pod", savedBytesPerDay: null, state: "open" },
      { ...base, id: "b", reason: "noisy", title: "GET /health", subtitle: "web", savedBytesPerDay: 300, state: "open" },
      { ...base, id: "c", reason: "debug", title: "api", subtitle: "debug + trace lines", savedBytesPerDay: 100, state: "active" },
      { ...base, id: "d", reason: "noisy", title: "x", subtitle: "api", savedBytesPerDay: 900, state: "open" },
    ])
    expect(plans.map((plan) => plan.service)).toEqual(["api", "web", null])
    expect(plans[0]).toMatchObject({ bytesPerDay: 2000, openSavings: 900, totalSavings: 1000 })
    expect(plans[0].cuts.map((cut) => cut.id)).toEqual(["c", "d"])
  })
})
