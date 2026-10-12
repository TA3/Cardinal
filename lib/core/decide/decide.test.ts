import { describe, expect, it } from "vitest"

import { suggestMergeChoice } from "@/lib/core/decide/merge"
import {
  assessLog,
  assessMetric,
  compareAssessments,
} from "@/lib/core/decide/risk"
import type { UsageEvidence } from "@/lib/core/usage-gate"

const scan = (
  usages: NonNullable<UsageEvidence["dashboards"]>["usages"] = []
) => ({
  host: "grafana.example",
  scannedAt: new Date().toISOString(),
  dashboardsScanned: 12,
  alertsScanned: 4,
  usages,
})

const evidence = (overrides: Partial<UsageEvidence> = {}): UsageEvidence => ({
  rules: [],
  cloud: false,
  cloudUsage: null,
  ...overrides,
})

const dropMetric = {
  reason: "unused" as const,
  estimate: false,
  rule: { kind: "drop_metric" as const, metric: "m" },
}

describe("assessMetric", () => {
  it("rates an unused metric safe once dashboards were checked too", () => {
    const risk = assessMetric(dropMetric, evidence({ dashboards: scan() }))
    expect(risk.level).toBe("safe")
    expect(risk.confidence).toBeCloseTo(0.75)
  })

  it("asks for review when only alerting and recording rules were checked", () => {
    const risk = assessMetric(dropMetric, evidence())
    expect(risk.level).toBe("review")
    expect(risk.why[0]).toMatch(/dashboards not checked/)
    expect(risk.missing).toBe("dashboards")
  })

  it("asks for review when usage couldn't be read at all", () => {
    expect(assessMetric(dropMetric, undefined).level).toBe("review")
    expect(assessMetric(dropMetric, undefined).confidence).toBe(0)
    expect(assessMetric(dropMetric, evidence({ rules: null })).level).toBe(
      "review"
    )
  })

  it("rates a metric an alert reads risky", () => {
    const risk = assessMetric(
      dropMetric,
      evidence({
        rules: [{ group: "g", name: "HighLatency", type: "alerting" }],
        dashboards: scan(),
      })
    )
    expect(risk.level).toBe("risky")
  })

  it("never rates a bucket trim or a churn label safe, and discounts estimates", () => {
    const buckets = assessMetric(
      {
        reason: "buckets",
        estimate: true,
        rule: { kind: "keep_buckets", metric: "m_bucket", buckets: ["1"] },
      },
      evidence({ dashboards: scan() })
    )
    expect(buckets.level).toBe("review")
    expect(buckets.confidence).toBeCloseTo(0.6)
    const churn = assessMetric(
      {
        reason: "churn",
        label: "pod",
        estimate: true,
        rule: { kind: "drop_labels", metric: "m", labels: ["pod"] },
      },
      evidence({ dashboards: scan() })
    )
    expect(churn.level).toBe("review")
  })
})

describe("assessLog", () => {
  it("rates debug drops safe and sampling for review", () => {
    expect(
      assessLog({ reason: "debug", title: "api", estimate: true }).level
    ).toBe("safe")
    expect(
      assessLog({
        reason: "noisy",
        title: "GET /health <_> 200",
        subtitle: "api",
        estimate: true,
      }).level
    ).toBe("review")
  })

  it("rates lines that look like audit or billing trails risky", () => {
    const risk = assessLog({
      reason: "noisy",
      title: "payment <_> captured for order <_>",
      subtitle: "checkout",
      estimate: true,
    })
    expect(risk.level).toBe("risky")
    expect(risk.why[0]).toMatch(/audit, security or billing/)
  })

  it("rates a label move by whether queries select by it", () => {
    expect(
      assessLog({ reason: "labels", title: "request_id", estimate: true }).level
    ).toBe("review")
    expect(
      assessLog(
        { reason: "labels", title: "request_id", estimate: true },
        { labelQueried: false }
      ).level
    ).toBe("safe")
    expect(
      assessLog(
        { reason: "labels", title: "request_id", estimate: true },
        { labelQueried: true }
      ).level
    ).toBe("risky")
  })

  it("orders safe before review before risky", () => {
    const sorted = [
      { level: "risky" as const, confidence: 1, why: [] },
      { level: "safe" as const, confidence: 0.4, why: [] },
      { level: "review" as const, confidence: 1, why: [] },
      { level: "safe" as const, confidence: 0.9, why: [] },
    ].sort(compareAssessments)
    expect(sorted.map((item) => `${item.level}:${item.confidence}`)).toEqual([
      "safe:0.9",
      "safe:0.4",
      "review:1",
      "risky:1",
    ])
  })
})

describe("suggestMergeChoice", () => {
  it("drops unused labels, aggregates used ones where possible, else leaves the choice open", () => {
    expect(
      suggestMergeChoice({ used: false, choices: ["drop", "keep_value"] })
    ).toBe("drop")
    expect(
      suggestMergeChoice({
        used: true,
        choices: ["drop", "keep_value", "aggregate"],
      })
    ).toBe("aggregate")
    expect(
      suggestMergeChoice({ used: true, choices: ["drop", "keep_value"] })
    ).toBeNull()
    expect(
      suggestMergeChoice({
        used: undefined,
        choices: ["drop", "keep_value", "aggregate"],
      })
    ).toBeNull()
  })
})
