import type { AdaptiveLogsExemption, AdaptiveLogsRecommendation } from "@/lib/core/logs/adaptive-apply"
import type { AdaptiveLogsDropRule } from "@/lib/core/logs/compile/adaptive-logs"
import { adaptiveLogsBaseUrl } from "@/lib/core/grafana-cloud"
import { send, sendJson, type Connection } from "@/lib/sources/transport"

// Grafana Cloud Adaptive Logs HTTP API, as documented at
// https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/manage-as-code/adaptive-logs-api/
// It lives on the hosted Loki host (https://logs-prod-….grafana.net), takes
// basic auth <instance id>:<token> with the adaptive-logs:admin scope, and
// sends no CORS headers, so it always goes through the Cardinal proxy.
// Only the endpoints on that page are used.

export type { AdaptiveLogsExemption, AdaptiveLogsRecommendation }

export interface AdaptiveLogsSegment {
  id?: string
  name: string
  selector: string
}

export { adaptiveLogsBaseUrl }

export function hasAdaptiveLogs(connection: Connection) {
  return adaptiveLogsBaseUrl(connection.baseUrl) !== null
}

function adaptiveConnection(connection: Connection): Connection {
  const baseUrl = adaptiveLogsBaseUrl(connection.baseUrl)
  if (!baseUrl) throw new Error("Adaptive Logs needs a Grafana Cloud Loki URL (https://logs-prod-….grafana.net)")
  return { ...connection, baseUrl, mode: "proxy" }
}

/** Pattern recommendations; regenerated every 24 hours. */
export function fetchLogRecommendations(connection: Connection, signal?: AbortSignal) {
  return sendJson<AdaptiveLogsRecommendation[]>(adaptiveConnection(connection), { path: "/adaptive-logs/recommendations", signal }).then(
    (items) => items ?? []
  )
}

export function fetchLogExemptions(connection: Connection, signal?: AbortSignal) {
  return sendJson<AdaptiveLogsExemption[]>(adaptiveConnection(connection), { path: "/adaptive-logs/exemptions", signal }).then(
    (items) => items ?? []
  )
}

export function fetchLogDropRules(
  connection: Connection,
  options: { segmentId?: string; expiration?: "all" | "active" | "expired"; signal?: AbortSignal } = {}
) {
  const query: Record<string, string> = {}
  if (options.segmentId) query.segment_id = options.segmentId
  if (options.expiration) query.expiration_filter = options.expiration
  return sendJson<AdaptiveLogsDropRule[]>(adaptiveConnection(connection), {
    path: "/adaptive-logs/drop-rules",
    query,
    signal: options.signal,
  }).then((items) => items ?? [])
}

export function fetchLogSegments(connection: Connection, signal?: AbortSignal) {
  return sendJson<AdaptiveLogsSegment[]>(adaptiveConnection(connection), { path: "/adaptive-logs/segments", signal }).then(
    (items) => items ?? []
  )
}

/** POST /adaptive-logs/drop-rules; returns the created rule (with its id). */
export async function createLogDropRule(connection: Connection, rule: AdaptiveLogsDropRule) {
  const response = await send(adaptiveConnection(connection), { path: "/adaptive-logs/drop-rules", method: "POST", body: writable(rule) })
  return (await response.json()) as AdaptiveLogsDropRule
}

/** Server-set ids go into the path; refuse anything the proxy wouldn't forward. */
function idPath(kind: "drop-rules" | "exemptions", id: string | undefined) {
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`Invalid Adaptive Logs id ${JSON.stringify(id)}`)
  return `/adaptive-logs/${kind}/${id}`
}

/** Fields the server sets; left out of writes. */
function writable(rule: AdaptiveLogsDropRule): AdaptiveLogsDropRule {
  return {
    segment_id: rule.segment_id,
    name: rule.name,
    version: rule.version,
    disabled: rule.disabled,
    ...(rule.expires_at ? { expires_at: rule.expires_at } : {}),
    body: rule.body,
  }
}

/** PUT /adaptive-logs/drop-rules/<id>. `version` must be the rule's current version (optimistic concurrency). */
export async function updateLogDropRule(connection: Connection, id: string, rule: AdaptiveLogsDropRule) {
  const response = await send(adaptiveConnection(connection), { path: idPath("drop-rules", id), method: "PUT", body: writable(rule) })
  const text = await response.text()
  return (text ? JSON.parse(text) : { ...rule, id }) as AdaptiveLogsDropRule
}

/** DELETE /adaptive-logs/drop-rules/<id>. */
export async function deleteLogDropRule(connection: Connection, id: string) {
  await send(adaptiveConnection(connection), { path: idPath("drop-rules", id), method: "DELETE" })
}

/** DELETE /adaptive-logs/exemptions/<id>. */
export async function deleteLogExemption(connection: Connection, id: string) {
  await send(adaptiveConnection(connection), { path: idPath("exemptions", id), method: "DELETE" })
}

/** POST /adaptive-logs/exemptions, or /expiring-exemptions when active_interval is set. */
export async function createLogExemption(connection: Connection, exemption: AdaptiveLogsExemption) {
  const path = exemption.active_interval ? "/adaptive-logs/expiring-exemptions" : "/adaptive-logs/exemptions"
  const response = await send(adaptiveConnection(connection), { path, method: "POST", body: exemption })
  return (await response.json()) as AdaptiveLogsExemption
}

/** Pattern text from its tokens, e.g. `level=info msg=<*>`. */
export function recommendationPattern(recommendation: Pick<AdaptiveLogsRecommendation, "tokens">) {
  return recommendation.tokens.join("")
}
