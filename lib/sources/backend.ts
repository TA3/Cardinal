import { classifyBackend, type BackendProbe, type BackendProfile, type BuildInfo } from "@/lib/core/backend-profile"
import { send, sendJson, type Connection } from "@/lib/sources/transport"
import type { PrometheusResponse } from "@/lib/prometheus/types"

// Probes that tell Prometheus, Mimir, Grafana Cloud, Thanos and
// VictoriaMetrics apart (classified in lib/core/backend-profile). Each probe
// that fails just counts as "not there"; only an abort is thrown.

function isAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

async function probe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isAbort(error)) throw error
    return fallback
  }
}

async function data<T>(connection: Connection, path: string, query: Record<string, string>, signal?: AbortSignal) {
  const payload = await sendJson<PrometheusResponse<T>>(connection, { path: `/api/v1${path}`, query, signal })
  if (payload.status !== "success" || payload.data === undefined) throw new Error(payload.error ?? "not supported")
  return payload.data
}

export async function detectBackend(connection: Connection, signal?: AbortSignal): Promise<BackendProfile> {
  const [buildinfo, tsdb] = await Promise.all([
    probe(() => data<BuildInfo>(connection, "/status/buildinfo", {}, signal), null),
    probe(async () => {
      const stats = await data<Record<string, unknown>>(connection, "/status/tsdb", { limit: "1" }, signal)
      // VictoriaMetrics reports totals where Prometheus reports headStats.
      return "totalSeries" in stats && !("headStats" in stats) ? ("victoriametrics" as const) : ("prometheus" as const)
    }, null),
  ])
  const decided = /mimir|cortex/i.test(buildinfo?.application ?? "") || tsdb !== null
  const mimirCardinality = decided
    ? false
    : await probe(async () => {
        await send(connection, { path: "/api/v1/cardinality/label_names", query: { limit: "1" }, signal })
        return true
      }, false)
  const found: BackendProbe = { baseUrl: connection.baseUrl, buildinfo, tsdb, mimirCardinality }
  return classifyBackend(found)
}
