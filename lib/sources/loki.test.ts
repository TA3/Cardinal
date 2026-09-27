import { describe, expect, it } from "vitest"

import type { LogsSnapshot, LogsSnapshotProgress } from "@/lib/core/logs/types"

// Loaded at runtime like sources.test.ts: lib/sources needs DOM types the test project lacks.
interface Connection {
  baseUrl: string
  mode: "direct" | "proxy"
}
interface Loki {
  fetchLogsSnapshot(
    connection: Connection,
    options: { range: "1h" | "24h" | "7d"; groupLabel?: string; now?: number; onStep?: (progress: LogsSnapshotProgress) => void }
  ): Promise<LogsSnapshot>
  fetchPatterns(connection: Connection, selector: { text: string }): Promise<unknown[] | null>
  fetchLokiLabelValues(connection: Connection, label: string): Promise<string[]>
}
const lokiPath = "@/lib/sources/loki"
const loadLoki = async () => (await import(/* @vite-ignore */ lokiPath)) as Loki

const base = { baseUrl: "https://loki.example/api/datasources/proxy/uid/logs", mode: "direct" as const }
const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 })

async function withFetch<T>(handler: (url: URL) => Response, run: () => Promise<T>) {
  const original = globalThis.fetch
  const calls: URL[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input))
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  try {
    return { result: await run(), calls }
  } finally {
    globalThis.fetch = original
  }
}

describe("loki client", () => {
  it("builds a logs snapshot from the index APIs", async () => {
    const { fetchLogsSnapshot } = await loadLoki()
    const steps: LogsSnapshotProgress[] = []
    const { result, calls } = await withFetch(
      (url) => {
        const path = url.pathname.replace("/api/datasources/proxy/uid/logs", "")
        const query = url.searchParams.get("query") ?? ""
        if (path === "/loki/api/v1/labels") return ok(["__time_shard__", "job", "service_name", "pod"])
        if (path === "/loki/api/v1/index/volume")
          return ok({ result: [{ metric: { service_name: "api" }, value: [0, "300"] }, { metric: { service_name: "web" }, value: [0, "700"] }] })
        if (path === "/loki/api/v1/index/stats") {
          const streams = query === '{service_name=~".+"}' ? 30 : query.includes('"web"') ? 20 : 10
          return new Response(JSON.stringify({ streams, chunks: 1, entries: 5, bytes: 1000 }))
        }
        if (path === "/loki/api/v1/label/pod/values") return ok(["a-1", "a-2", "b-1"])
        if (path === "/loki/api/v1/label/job/values") return ok(["x"])
        if (path === "/loki/api/v1/label/service_name/values") return ok(["api", "web"])
        return new Response("not found", { status: 404 })
      },
      () => fetchLogsSnapshot(base, { range: "1h", now: 7_200_000, onStep: (step) => steps.push(step) })
    )
    expect(result.groupLabel).toBe("service_name")
    expect(result.host).toBe("loki.example")
    expect(result.totals).toEqual({ streams: 30, bytes: 1000, lines: 5, labelCount: 3 })
    expect(result.groups.map((group) => [group.value, group.streams, group.bytes])).toEqual([
      ["web", 20, 700],
      ["api", 10, 300],
    ])
    expect(result.labels.map((label) => [label.label, label.distinctValues])).toEqual([
      ["pod", 3],
      ["service_name", 2],
      ["job", 1],
    ])
    const volume = calls.find((url) => url.pathname.endsWith("/index/volume"))!
    expect(volume.searchParams.get("targetLabels")).toBe("service_name")
    expect(volume.searchParams.get("start")).toBe("3600000000000")
    expect(volume.searchParams.get("end")).toBe("7200000000000")
    expect(calls.some((url) => url.pathname.includes("__time_shard__"))).toBe(false)
    expect(steps.at(-1)).toEqual({ done: 5, total: 5, phase: "Reading label values" })
  })

  it("treats a missing pattern ingester as unsupported, not an error", async () => {
    const { fetchPatterns } = await loadLoki()
    const { result } = await withFetch(() => new Response("404 page not found", { status: 404 }), () => fetchPatterns(base, { text: '{job="x"}' }))
    expect(result).toBeNull()
  })

  it("refuses invalid label names before calling Loki", async () => {
    const { fetchLokiLabelValues } = await loadLoki()
    await expect(fetchLokiLabelValues(base, "../../admin")).rejects.toThrow(/label name/)
  })
})
