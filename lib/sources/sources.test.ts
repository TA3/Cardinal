import { describe, expect, it } from "vitest"

import type { Snapshot } from "@/lib/core/snapshot"

// lib/sources needs DOM types, which the test (worker) project lacks, so the
// modules are loaded at runtime with minimal local types (as in core.test.ts).
type AuthMode = "none" | "basic" | "bearer" | "grafana-cloud" | "mimir"
interface Connection {
  baseUrl: string
  mode: "direct" | "proxy"
  auth?: AuthMode
  instanceId?: string
  token?: string
  tenant?: string
}
interface Progress {
  done: number
  total: number
  phase: string
}
interface Transport {
  authHeaders(connection: Connection): Record<string, string>
  inferAuthMode(fields: { baseUrl: string; instanceId?: string; token?: string; tokenExpected?: boolean }): AuthMode
}
interface Prometheus {
  fetchSnapshot(connection: Connection, topN: number, options?: { onStep?: (progress: Progress) => void }): Promise<Snapshot>
}
const transportPath = "@/lib/sources/transport"
const prometheusPath = "@/lib/sources/prometheus"
const loadTransport = async () => (await import(/* @vite-ignore */ transportPath)) as Transport
const loadPrometheus = async () => (await import(/* @vite-ignore */ prometheusPath)) as Prometheus

const base = { baseUrl: "https://prom.example", mode: "direct" as const }

describe("auth modes", () => {
  it("sends a lone token as Bearer instead of dropping it", async () => {
    const { authHeaders } = await loadTransport()
    expect(authHeaders({ ...base, auth: "bearer", token: "t0k" })).toEqual({ Authorization: "Bearer t0k" })
    expect(authHeaders({ ...base, token: "t0k" }).Authorization).toBe("Bearer t0k")
    expect(authHeaders({ ...base, auth: "basic", instanceId: "u", token: "p" }).Authorization).toBe(`Basic ${btoa("u:p")}`)
    expect(authHeaders({ ...base, auth: "none", token: "ignored" })).toEqual({})
  })

  it("requires Grafana Cloud credentials and sends the Mimir tenant", async () => {
    const { authHeaders } = await loadTransport()
    expect(() => authHeaders({ ...base, auth: "grafana-cloud", token: "glc" })).toThrow(/instance ID/)
    expect(() => authHeaders({ ...base, auth: "mimir" })).toThrow(/X-Scope-OrgID/)
    expect(authHeaders({ ...base, auth: "mimir", tenant: "team-a" })).toEqual({ "X-Scope-OrgID": "team-a" })
    expect(authHeaders({ ...base, auth: "mimir", tenant: "a", token: "t" })).toEqual({ "X-Scope-OrgID": "a", Authorization: "Bearer t" })
  })

  it("infers the mode of settings saved before auth modes", async () => {
    const { inferAuthMode } = await loadTransport()
    expect(inferAuthMode({ baseUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom", instanceId: "1" })).toBe("grafana-cloud")
    expect(inferAuthMode({ baseUrl: "https://prom.example", instanceId: "u", token: "p" })).toBe("basic")
    expect(inferAuthMode({ baseUrl: "https://prom.example", tokenExpected: true })).toBe("bearer")
    expect(inferAuthMode({ baseUrl: "https://prom.example" })).toBe("none")
  })
})

describe("large tenants", () => {
  it("falls back to per-job counts, then to the cardinality API, when queries hit limits", async () => {
    const { fetchSnapshot } = await loadPrometheus()
    const limit = () =>
      new Response(JSON.stringify({ status: "error", error: "the query exceeded the maximum number of series (limit: 100000)" }), {
        status: 422,
      })
    const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input))
      const query = url.searchParams.get("query") ?? ""
      if (url.pathname.endsWith("/api/v1/labels")) return ok(["job"])
      if (url.pathname.endsWith("/label/job/values")) return ok(["api", "big"])
      if (url.pathname.endsWith("/cardinality/label_values")) {
        return new Response(
          JSON.stringify({
            labels: [{ label_name: "__name__", label_values_count: 600, cardinality: [{ label_value: "huge_metric", series_count: 90 }] }],
          })
        )
      }
      if (query.startsWith("count by (job, __name__)")) return limit()
      if (query.includes('job="big"')) return limit()
      if (query.includes('job="api"')) return ok({ result: [{ metric: { __name__: "up" }, value: [0, "3"] }] })
      if (query.includes('job=""')) return ok({ result: [] })
      return ok({ result: [] })
    }) as typeof fetch
    const steps: Progress[] = []
    try {
      const snapshot = await fetchSnapshot(base, 5, { onStep: (step) => steps.push(step) })
      expect(snapshot.method).toBe("per-job")
      expect(snapshot.host).toBe("prom.example")
      expect(snapshot.totalSeries).toBe(93)
      expect(snapshot.truncatedJobs).toEqual(["big"])
      expect(snapshot.skippedJobs).toBeUndefined()
      expect(steps.at(-1)).toEqual({ done: 3, total: 3, phase: "Querying jobs" })
    } finally {
      globalThis.fetch = original
    }
  })
})
