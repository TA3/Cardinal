import {
  isPrivateHost,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
  PROXY_TARGET_HEADER,
  PROXY_TOKEN_HEADER,
} from "@/lib/sources/proxy-constants"
import { clientIp, isSameOrigin, verifyProxyToken } from "./guard"

export { isPrivateHost }

// Credential pass-through proxy for backends that do not send CORS headers
// (Grafana Cloud included). Nothing is stored or logged. Only read-style
// observability APIs, the Adaptive Metrics and Adaptive Logs APIs and Grafana's
// dashboard create endpoint are reachable, and only on public hosts. Callers
// must be same-origin and hold a fresh proxy token (see guard.ts for what that
// does and does not guarantee).

const PROMETHEUS_API = /\/api\/v1\/(query|query_range|labels|label\/[^/]+\/values|series|metadata|rules|status\/(buildinfo|tsdb)|cardinality\/(label_names|label_values))/
const LOKI_API =
  /\/loki\/api\/v1\/(labels|label\/[^/]+\/values|series|index\/(stats|volume|volume_range)|query_range|detected_labels|detected_fields|patterns|status\/buildinfo)/
const DATASOURCE_PROXY = "\\/api\\/datasources\\/proxy\\/uid\\/[A-Za-z0-9_-]{1,64}"
// Loki's own alerting and recording rules (YAML and Prometheus-style JSON), for "is this selector used?" checks.
const LOKI_RULES_API = /\/(loki\/api\/v1|prometheus\/api\/v1)\/rules/
// Grafana Cloud Adaptive Logs on the hosted Loki host. Ids are server-set; keep them to a safe charset.
const ADAPTIVE_LOGS_ID = "[A-Za-z0-9_-]{1,128}"

const ALLOWED_PATHS: Array<{ pattern: RegExp; methods: string[] }> = [
  { pattern: new RegExp(`^${PROMETHEUS_API.source}$`), methods: ["GET", "POST"] },
  { pattern: /^\/aggregations\/(recommendations|rules)$/, methods: ["GET"] },
  { pattern: /^\/aggregations\/(rules|check-rules)$/, methods: ["POST"] },
  { pattern: new RegExp(`^${LOKI_API.source}$`), methods: ["GET", "POST"] },
  { pattern: new RegExp(`^${LOKI_RULES_API.source}$`), methods: ["GET"] },
  // Adaptive Logs: reads everywhere; writes only to drop rules and exemptions (like Adaptive Metrics' rules).
  { pattern: /^\/adaptive-logs\/(recommendations|drop-rules|exemptions|expiring-exemptions|segments)$/, methods: ["GET"] },
  { pattern: /^\/adaptive-logs\/(drop-rules|exemptions|expiring-exemptions)$/, methods: ["POST"] },
  { pattern: new RegExp(`^\\/adaptive-logs\\/(drop-rules|exemptions)\\/${ADAPTIVE_LOGS_ID}$`), methods: ["GET", "PUT", "DELETE"] },
  // Grafana dashboard and alert usage scans: read-only, GET only. Uids are [A-Za-z0-9_-].
  {
    pattern:
      /^\/api\/(search|datasources|dashboards\/uid\/[A-Za-z0-9_-]{1,64}|library-elements\/[A-Za-z0-9_-]{1,64}|v1\/provisioning\/alert-rules|ruler\/grafana\/api\/v1\/rules)$/,
    methods: ["GET"],
  },
  // "Create in Grafana" for the exported Cardinal dashboard (needs Editor). The only Grafana write.
  { pattern: /^\/api\/dashboards\/db$/, methods: ["POST"] },
  // Prometheus and Loki reads through Grafana's data source proxy (base URL = the Grafana root): GET only.
  { pattern: new RegExp(`^${DATASOURCE_PROXY}(${PROMETHEUS_API.source}|${LOKI_API.source}|${LOKI_RULES_API.source})$`), methods: ["GET"] },
]

/** Whether the proxy forwards `method path` (path relative to the target's base URL). */
export function isAllowedPath(method: string, path: string) {
  // Encoded slashes or dot segments could walk out of an allowed prefix upstream.
  if (/%2f|%5c|\\|(^|\/)\.\.?(\/|$)/i.test(path)) return false
  return ALLOWED_PATHS.some((entry) => entry.methods.includes(method) && entry.pattern.test(path))
}

// x-scope-orgid selects the Mimir / Cortex tenant.
const FORWARDED_REQUEST_HEADERS = ["authorization", "content-type", "accept", "if-match", "x-scope-orgid"]
const FORWARDED_RESPONSE_HEADERS = ["content-type", "etag", "last-modified"]

function error(status: number, message: string, kind?: string) {
  const response = Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
  // Lets the UI tell the proxy's own failures apart from the backend's.
  if (kind) response.headers.set(PROXY_ERROR_HEADER, kind)
  return response
}

/** Best-effort reason a fetch to the backend failed: "dns", "timeout" or "unreachable". */
function unreachableKind(cause: unknown) {
  const text = String(cause)
  if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) return "timeout"
  if (/timed? ?out/i.test(text)) return "timeout"
  if (/dns|ENOTFOUND|resolve|getaddrinfo|name not known/i.test(text)) return "dns"
  return "unreachable"
}

export async function handleProxy(request: Request, secret: string | undefined): Promise<Response> {
  if (!isSameOrigin(request)) return error(403, "Cross-origin proxy use is not allowed")
  const token = request.headers.get(PROXY_TOKEN_HEADER) ?? ""
  if (!(await verifyProxyToken(secret, token, clientIp(request)))) {
    return error(401, "Missing or expired proxy token", "token")
  }

  const targetHeader = request.headers.get(PROXY_TARGET_HEADER)
  if (!targetHeader) return error(400, `Missing ${PROXY_TARGET_HEADER} header`)

  let target: URL
  try {
    target = new URL(targetHeader)
  } catch {
    return error(400, "Invalid target URL")
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return error(400, "Target must be http(s)")
  if (target.username || target.password) return error(400, "Credentials in the target URL are not allowed")
  if (isPrivateHost(target.hostname)) {
    return error(400, "Private and loopback hosts cannot be proxied. Use direct mode for backends on your network.", "private")
  }

  const url = new URL(request.url)
  const path = url.pathname.slice(PROXY_PREFIX.length)
  if (!isAllowedPath(request.method, path)) {
    return error(403, `Path not allowed through the proxy: ${request.method} ${path}`, "path")
  }

  const upstream = new URL(`${target.origin}${target.pathname.replace(/\/+$/, "")}${path}`)
  upstream.search = url.search

  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  let response: Response
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    const kind = unreachableKind(cause)
    return error(kind === "timeout" ? 504 : 502, `Could not reach ${target.origin}: ${String(cause)}`, kind)
  }

  // Cloudflare answers 530 (error 1016) when the backend's hostname has no DNS record.
  if (response.status === 530) {
    await response.body?.cancel().catch(() => undefined)
    return error(502, `Could not resolve ${target.hostname} (DNS lookup failed)`, "dns")
  }

  if (response.status >= 300 && response.status < 400) {
    return error(502, `Upstream redirected (HTTP ${response.status}); check the URL path`, "redirect")
  }

  const out = new Headers({ "Cache-Control": "no-store" })
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers: out })
}
