import { PROXY_ERROR_HEADER, PROXY_PREFIX, PROXY_SKIP_VERIFY_HEADER, PROXY_TARGET_HEADER } from "@/lib/sources/proxy-constants"

// The forwarding half of the self-hosted server's proxy (server/). Callers
// authenticate the request first (lib/proxy/guard); this checks the target
// and path and forwards it. Private and loopback targets are fine: the server
// runs on the user's own machine or network. Only
// read-style observability APIs, the Adaptive Metrics and Adaptive Logs APIs
// and Grafana's dashboard create endpoint are reachable. Nothing is stored.

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
export const FORWARDED_REQUEST_HEADERS = ["authorization", "content-type", "accept", "if-match", "x-scope-orgid"]
export const FORWARDED_RESPONSE_HEADERS = ["content-type", "etag", "last-modified"]

export function proxyError(status: number, message: string, kind?: string) {
  const response = Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
  // Lets the UI tell the proxy's own failures apart from the backend's.
  if (kind) response.headers.set(PROXY_ERROR_HEADER, kind)
  return response
}

/** A failed fetch and its causes: Node's fetch says only "fetch failed" and keeps the reason in `cause`. */
function causesOf(error: unknown) {
  const chain: unknown[] = []
  for (let current = error; current && chain.length < 4; current = (current as { cause?: unknown }).cause) chain.push(current)
  return chain
}

function describeError(error: unknown) {
  const code = (error as { code?: unknown }).code
  // Node adds runtime advice after a semicolon ("try running Node.js with --use-system-ca"): Cardinal's flags are the fix here.
  const message = (error instanceof Error ? error.message : String(error)).split(";")[0]
  return typeof code === "string" && !message.includes(code) ? `${message} (${code})` : message
}

/** The innermost reason, e.g. "self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)". */
function causeOf(error: unknown) {
  return describeError(causesOf(error).at(-1))
}

/** Best-effort reason a fetch to the backend failed: "dns", "timeout", "tls" or "unreachable". */
function unreachableKind(cause: unknown) {
  const text = causesOf(cause).map(describeError).join(" ")
  if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) return "timeout"
  if (/timed? ?out/i.test(text)) return "timeout"
  if (/dns|ENOTFOUND|resolve|getaddrinfo|name not known/i.test(text)) return "dns"
  if (/CERT|certificate|self[- ]signed|UNABLE_TO_VERIFY|altname/i.test(text)) return "tls"
  return "unreachable"
}

/** What went wrong reaching `target`, with the flag that helps where there is one. */
function unreachableMessage(kind: string, target: URL, cause: unknown, timeoutMs: number) {
  const why = causeOf(cause)
  if (kind === "timeout") return `${target.origin} didn't answer within ${Math.round(timeoutMs / 1000)} s; start Cardinal with --proxy-timeout <s> to wait longer`
  if (kind === "tls") {
    return `${target.origin}'s certificate isn't trusted (${why}). If your own CA signed it, start Cardinal with --proxy-ca <file>; if it's self-signed, turn on Skip certificate check for this connection, under Advanced`
  }
  return `Could not reach ${target.origin}: ${why}`
}

/**
 * Host allowlist entries: `host`, `host:port` or `*.domain` (any subdomain).
 * An empty list allows every host.
 */
export function isHostAllowed(target: URL, allowHosts: readonly string[]) {
  if (!allowHosts.length) return true
  const host = target.hostname.toLowerCase().replace(/\.+$/, "")
  const port = target.port || (target.protocol === "https:" ? "443" : "80")
  return allowHosts.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (!entry) return false
    const match = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
    if (!match) return false
    const [, pattern, entryPort] = match
    if (entryPort && entryPort !== port) return false
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1))
    return host === pattern.replace(/\.+$/, "")
  })
}

export interface ForwardOptions {
  /** Optional target allowlist (see isHostAllowed). */
  allowHosts?: readonly string[]
  /** How long to wait for the backend, default 30 s. */
  timeoutMs?: number
  /** Reaches the backend; the server's own (through an HTTP proxy, say) or one for tests. */
  fetch?: typeof fetch
  /** Reaches the backend without checking its certificate, for a connection that asks (PROXY_SKIP_VERIFY_HEADER). */
  fetchSkippingVerify?: typeof fetch
}

/** The connection asks not to check this https backend's certificate (a self-signed one). */
export function skipsVerify(request: Request, target: URL) {
  return target.protocol === "https:" && request.headers.get(PROXY_SKIP_VERIFY_HEADER) === "1"
}

/** Checks the target and path of an authenticated `/api/proxy/*` request and forwards it. */
export async function forwardProxyRequest(request: Request, options: ForwardOptions): Promise<Response> {
  const targetHeader = request.headers.get(PROXY_TARGET_HEADER)
  if (!targetHeader) return proxyError(400, `Missing ${PROXY_TARGET_HEADER} header`)

  let target: URL
  try {
    target = new URL(targetHeader)
  } catch {
    return proxyError(400, "Invalid target URL")
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return proxyError(400, "Target must be http(s)")
  if (target.username || target.password) return proxyError(400, "Credentials in the target URL are not allowed")
  if (!isHostAllowed(target, options.allowHosts ?? [])) {
    return proxyError(403, `${target.host} is not in this server's host allowlist (--allow-hosts)`, "host")
  }

  const url = new URL(request.url)
  const path = url.pathname.slice(PROXY_PREFIX.length)
  if (!isAllowedPath(request.method, path)) {
    return proxyError(403, `Path not allowed through the proxy: ${request.method} ${path}`, "path")
  }

  const upstream = new URL(`${target.origin}${target.pathname.replace(/\/+$/, "")}${path}`)
  upstream.search = url.search

  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  const timeoutMs = options.timeoutMs ?? 30_000
  let send = options.fetch ?? fetch
  if (skipsVerify(request, target)) {
    if (!options.fetchSkippingVerify) return proxyError(501, "This Cardinal server can't skip certificate checks", "tls")
    send = options.fetchSkippingVerify
  }
  let response: Response
  try {
    response = await send(upstream, {
      method: request.method,
      headers,
      // Buffered rather than streamed: bodies are small (queries, rule lists), and Node's fetch refuses a stream without `duplex`.
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    const kind = unreachableKind(cause)
    return proxyError(kind === "timeout" ? 504 : 502, unreachableMessage(kind, target, cause, timeoutMs), kind)
  }

  // Cloudflare answers 530 (error 1016) when the backend's hostname has no DNS record.
  if (response.status === 530) {
    await response.body?.cancel().catch(() => undefined)
    return proxyError(502, `Could not resolve ${target.hostname} (DNS lookup failed)`, "dns")
  }

  if (response.status >= 300 && response.status < 400) {
    return proxyError(502, `Upstream redirected (HTTP ${response.status}); check the URL path`, "redirect")
  }

  const out = new Headers({ "Cache-Control": "no-store" })
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers: out })
}
