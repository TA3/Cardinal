import type { AdaptiveRecommendation, AggregationRule } from "@/lib/core/compile/adaptive-metrics"
import { adaptiveMetricsBaseUrl } from "@/lib/core/grafana-cloud"
import { send, sendJson, type Connection } from "@/lib/sources/transport"

// Grafana Cloud Adaptive Metrics API. Lives on the hosted Prometheus host
// without the /api/prom prefix and does not send CORS headers, so the UI always
// reaches it through the Cardinal proxy.

export { adaptiveMetricsBaseUrl }

export function isGrafanaCloud(connection: Connection) {
  return adaptiveMetricsBaseUrl(connection.baseUrl) !== null
}

function adaptiveConnection(connection: Connection): Connection {
  const baseUrl = adaptiveMetricsBaseUrl(connection.baseUrl)
  if (!baseUrl) throw new Error("Adaptive Metrics needs a Grafana Cloud Prometheus URL (https://prometheus-….grafana.net/api/prom)")
  return { ...connection, baseUrl, mode: "proxy" }
}

export async function fetchRecommendations(
  connection: Connection,
  options: { actions?: string[]; signal?: AbortSignal } = {}
): Promise<AdaptiveRecommendation[]> {
  const query: Record<string, string | string[]> = { verbose: "true" }
  if (options.actions?.length) query.action = options.actions
  return sendJson<AdaptiveRecommendation[]>(adaptiveConnection(connection), {
    path: "/aggregations/recommendations",
    query,
    signal: options.signal,
  })
}

export interface AdaptiveRuleset {
  rules: AggregationRule[]
  /** "" when the API sent no ETag. */
  etag: string
}

export async function fetchAggregationRules(connection: Connection, signal?: AbortSignal): Promise<AdaptiveRuleset> {
  const response = await send(adaptiveConnection(connection), { path: "/aggregations/rules", signal })
  return {
    rules: ((await response.json()) as AggregationRule[] | null) ?? [],
    etag: response.headers.get("ETag") ?? "",
  }
}

/** Returns validation errors; empty when the ruleset is valid. */
export async function checkAggregationRules(connection: Connection, rules: AggregationRule[]): Promise<string[]> {
  try {
    await send(adaptiveConnection(connection), { path: "/aggregations/check-rules", method: "POST", body: rules })
    return []
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

/**
 * Replaces the whole ruleset. `etag` must come from the fetch the rules were
 * computed from; the API rejects the write if anything changed in between.
 * Without an ETag no `If-Match` is sent (an empty one never matches).
 */
export async function saveAggregationRules(connection: Connection, rules: AggregationRule[], etag?: string) {
  const response = await send(adaptiveConnection(connection), {
    path: "/aggregations/rules",
    method: "POST",
    body: rules,
    headers: etag ? { "If-Match": etag } : {},
  })
  return response.headers.get("ETag") ?? ""
}
