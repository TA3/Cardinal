import { describe, expect, it } from "vitest"

import { DEFAULT_ATTRIBUTION } from "@/lib/core/attribution"
import { handoffHash, handoffUrl, readHandoffHash, type HandoffInput } from "@/lib/core/handoff"
import { createLogRule } from "@/lib/core/logs/rules"
import type { LogRuleInput } from "@/lib/core/logs/rules"
import { base64UrlEncode } from "@/lib/core/share"
import { createRule } from "@/lib/core/rules"
import { localBackendAdvice } from "@/lib/core/transport-plan"

const input = (patch: Partial<HandoffInput> = {}): HandoffInput => ({
  rules: [],
  logRules: [],
  prices: {},
  autopilot: false,
  attribution: DEFAULT_ATTRIBUTION,
  ...patch,
})

describe("handoff to a local Cardinal", () => {
  it("carries connections without tokens, keeps rules active or proposed, and opens the right form", () => {
    const active = createRule({ kind: "drop_metric", selector: { metric: "go_gc_duration_seconds" }, origin: "user", status: "active" })
    const proposed = createRule({ kind: "drop_labels", selector: { metric: "http_requests_total" }, labels: ["pod"], origin: "agent", status: "proposed" })
    const rejected = createRule({ kind: "drop_metric", selector: { metric: "up" }, origin: "user", status: "rejected" })
    const logRule = createLogRule({ kind: "drop_streams", selector: { matchers: [{ label: "service_name", op: "=", value: "debug" }] }, origin: "user", status: "active" } as LogRuleInput)
    const hash = handoffHash(
      input({
        metrics: { baseUrl: "http://10.0.0.5:9090/", instanceId: " me ", tenant: "" },
        grafana: { baseUrl: "https://grafana.lan" },
        rules: [active, proposed, rejected],
        logRules: [logRule],
        prices: { perSeries: 6.5 },
        autopilot: true,
        open: "metrics",
      })
    )
    expect(hash).not.toContain("token")
    const handoff = readHandoffHash(hash)!
    expect(handoff.metrics).toEqual({ baseUrl: "http://10.0.0.5:9090", instanceId: "me" })
    expect(handoff.grafana).toEqual({ baseUrl: "https://grafana.lan" })
    expect(handoff.rules.map((rule) => [rule.selector.metric, rule.status])).toEqual([
      ["go_gc_duration_seconds", "active"],
      ["http_requests_total", "proposed"],
    ])
    expect(handoff.logRules.map((rule) => rule.status)).toEqual(["active"])
    expect(handoff.prices).toEqual({ perSeries: 6.5 })
    expect(handoff.autopilot).toBe(true)
    expect(handoff.attribution).toBeUndefined()
    expect(handoff.open).toBe("metrics")
    expect(handoff.warnings).toEqual([])
    expect(handoffUrl(input())).toMatch(/^http:\/\/localhost:9181\/savings#handoff=/)
  })

  it("ignores hashes without a handoff and drops fields it can't trust", () => {
    expect(readHandoffHash("#rules=abc")).toBeNull()
    const hostile = `#handoff=${base64UrlEncode(
      JSON.stringify({
        v: 1,
        metrics: { baseUrl: "javascript:alert(1)" },
        logs: { baseUrl: "https://user:pass@loki.lan" },
        grafana: { baseUrl: "ftp://x" },
        prices: { perSeries: -1, perGB: "0.5" },
        autopilot: "yes",
        open: "settings",
      })
    )}`
    const handoff = readHandoffHash(hostile)!
    expect(handoff.metrics).toBeUndefined()
    expect(handoff.logs).toBeUndefined()
    expect(handoff.grafana).toBeUndefined()
    expect(handoff.prices).toEqual({})
    expect(handoff.autopilot).toBe(false)
    expect(handoff.open).toBeUndefined()
    expect(handoff.warnings).toHaveLength(2)
    expect(() => readHandoffHash(`#handoff=${base64UrlEncode(JSON.stringify({ v: 9 }))}`)).toThrow(/another version/)
  })
})

describe("advice for private backends from the hosted page", () => {
  const base = { pageHttps: true, privateHost: true, plainHttp: true, ownServer: false, localNetworkAccess: false }
  it("says what the browser will do before anyone tries", () => {
    expect(localBackendAdvice(base)).toBe("blocked")
    expect(localBackendAdvice({ ...base, localNetworkAccess: true })).toBe("local-network")
    expect(localBackendAdvice({ ...base, plainHttp: false })).toBe("cors")
    expect(localBackendAdvice({ ...base, privateHost: false })).toBeNull()
    expect(localBackendAdvice({ ...base, pageHttps: false })).toBeNull()
    expect(localBackendAdvice({ ...base, ownServer: true })).toBeNull()
  })
})
