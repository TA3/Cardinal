import { describe, expect, it } from "vitest"

import {
  appendDecisions,
  applyPreference,
  decisionsFor,
  isSnoozed,
  learnedPreference,
  logRuleKeys,
  MAX_DECISIONS,
  metricRuleKeys,
  snoozeExpired,
  type Decision,
} from "@/lib/core/decide/learn"
import type { Assessment } from "@/lib/core/decide/risk"
import { rankOpportunities, type MetricOpportunity } from "@/lib/core/opportunities"
import { createRule } from "@/lib/core/rules"

const decide = (keys: string[], outcome: Decision["outcome"], reason?: Decision["reason"]): Decision => ({
  keys,
  outcome,
  ...(reason ? { reason } : {}),
  at: "2026-10-01T00:00:00Z",
})

const review: Assessment = { level: "review", confidence: 0.4, why: ["Not in alert or recording rules; dashboards not checked"], missing: "dashboards" }

describe("rule keys", () => {
  it("files a metric cut under its kind, labels, namespace and job", () => {
    expect(metricRuleKeys({ kind: "drop_labels", metric: "grafana_http_requests_total", job: "grafana", labels: ["handler"] })).toEqual([
      "m:drop_labels",
      "m:drop_labels:label=handler",
      "m:drop_labels:ns=grafana",
      "m:drop_labels:job=grafana",
    ])
    // Stored rules carry the metric in their selector.
    expect(metricRuleKeys(createRule({ kind: "drop_metric", selector: { metric: "up" }, origin: "user", status: "proposed" }))).toEqual([
      "m:drop_metric",
      "m:drop_metric:ns=up",
    ])
  })

  it("files a log cut under its kind, exact matchers and label", () => {
    expect(
      logRuleKeys({
        kind: "label_to_metadata",
        selector: { matchers: [{ label: "service_name", op: "=", value: "api" }, { label: "level", op: "=~", value: "debug|trace" }] },
        label: "request_id",
      })
    ).toEqual(["l:label_to_metadata", "l:label_to_metadata:service_name=api", "l:label_to_metadata:label=request_id"])
  })
})

describe("learnedPreference", () => {
  const keys = ["m:drop_metric", "m:drop_metric:ns=grafana"]

  it("says nothing until there is enough history", () => {
    expect(learnedPreference([], keys)).toBeNull()
    expect(learnedPreference([decide(keys, "accept"), decide(keys, "accept")], keys)).toBeNull()
  })

  it("prefers the specific key with the most history over the broad one", () => {
    const decisions = [
      ...Array.from({ length: 3 }, () => decide(keys, "reject")),
      ...Array.from({ length: 5 }, () => decide(["m:drop_metric", "m:drop_metric:ns=node"], "accept")),
    ]
    expect(learnedPreference(decisions, keys)).toMatchObject({ key: "m:drop_metric:ns=grafana", accepted: 0, total: 3, rate: 0.2 })
    expect(learnedPreference(decisions, ["m:drop_metric", "m:drop_metric:ns=caddy"])).toMatchObject({ key: "m:drop_metric", accepted: 5, total: 8 })
  })

  it("ignores snoozes", () => {
    const decisions = Array.from({ length: 6 }, () => decide(keys, "reject", "later"))
    expect(learnedPreference(decisions, keys)).toBeNull()
  })
})

describe("applyPreference", () => {
  it("promotes a mostly-accepted review cut to safe and says why", () => {
    const risk = applyPreference(review, { key: "k", accepted: 5, total: 5, rate: 6 / 7 })
    expect(risk.level).toBe("safe")
    expect(risk.why[0]).toBe("You accepted 5 of 5 like this")
  })

  it("demotes a mostly-rejected cut one level", () => {
    const pref = { key: "k", accepted: 0, total: 4, rate: 1 / 6 }
    expect(applyPreference({ ...review, level: "safe" }, pref).level).toBe("review")
    expect(applyPreference(review, pref).level).toBe("risky")
    expect(applyPreference(review, pref).why[0]).toBe("You turned down 4 of 4 like this")
  })

  it("never turns risky safe, nor promotes when usage couldn't be checked", () => {
    const pref = { key: "k", accepted: 9, total: 9, rate: 10 / 11 }
    expect(applyPreference({ ...review, level: "risky" }, pref).level).toBe("risky")
    expect(applyPreference({ ...review, missing: "usage" }, pref).level).toBe("review")
  })
})

describe("recording decisions", () => {
  const proposed = createRule({ kind: "drop_metric", selector: { metric: "up" }, origin: "agent", status: "proposed" })
  const active = createRule({ kind: "drop_metric", selector: { metric: "node_load1" }, origin: "user", status: "active" })

  it("files only proposals that are accepted or rejected", () => {
    expect(decisionsFor([proposed, active], "active", metricRuleKeys)).toHaveLength(1)
    expect(decisionsFor([proposed], "rejected", metricRuleKeys, "used")[0]).toMatchObject({ outcome: "reject", reason: "used" })
    expect(decisionsFor([proposed], "proposed", metricRuleKeys)).toEqual([])
  })

  it("keeps the newest decisions", () => {
    const many = Array.from({ length: MAX_DECISIONS }, () => decide(["a"], "accept"))
    const next = appendDecisions(many, [decide(["b"], "reject")])
    expect(next).toHaveLength(MAX_DECISIONS)
    expect(next.at(-1)?.keys).toEqual(["b"])
  })
})

describe("snoozes", () => {
  const now = Date.parse("2026-10-12T00:00:00Z")
  const rejected = createRule({ kind: "drop_metric", selector: { metric: "up" }, origin: "user", status: "rejected" })

  it("hides a snoozed cut until the snooze runs out", () => {
    const opportunity: MetricOpportunity = {
      id: "x",
      reason: "unused",
      metric: "up",
      savedSeries: 100,
      estimate: false,
      rule: { kind: "drop_metric", metric: "up" },
      rationale: "",
    }
    const snoozed = { ...rejected, snoozedUntil: "2026-11-01T00:00:00Z" }
    expect(isSnoozed(snoozed, now)).toBe(true)
    expect(rankOpportunities([opportunity], [snoozed], now)).toEqual([])
    const expired = { ...rejected, snoozedUntil: "2026-10-01T00:00:00Z" }
    expect(snoozeExpired(expired, now)).toBe(true)
    expect(rankOpportunities([opportunity], [expired], now)).toHaveLength(1)
    // A plain rejection hides it for good.
    expect(rankOpportunities([opportunity], [rejected], now)).toEqual([])
  })
})
