import { FORWARDED_REQUEST_HEADERS, forwardProxyRequest, proxyError, skipsVerify } from "../lib/proxy/core"
import {
  CLIENT_HEADER,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
  PROXY_SKIP_VERIFY_HEADER,
  PROXY_TARGET_HEADER,
  PROXY_TOKEN_HEADER,
  PROXY_TOKEN_PATH,
  SERVER_INFO_PATH,
  type ServerInfo,
} from "../lib/sources/proxy-constants"
import { isSameOrigin, issueProxyToken, verifyProxyToken } from "../lib/proxy/guard"
import type { ServerConfig } from "./config"
import { serveStatic, type Assets } from "./static"

// The self-hosted `cardinal` server: the app plus the same /api/proxy contract
// as the hosted Worker, except that private hosts are allowed. Only the app it
// serves may use the proxy: requests must be same-origin and carry a proxy
// token, and the Host must be localhost, an IP, a non-public name (.local,
// .lan, single-label…) or listed in --public-hosts, so a DNS-rebinding page
// posing as this origin can't use it. Other origins get no CORS headers,
// except sites named with --allow-origin (the hosted app, say): they may use
// the proxy as this page does, so their pages keep credentials and queries on
// this machine too.

export const AGENT_UNAVAILABLE =
  "Agent sessions need the hosted app at https://cardinal.ta3.dev; this server keeps your credentials and queries on your own machine."

/** Names nobody can register publicly, so a rebinding attacker can't serve a page under them. */
const PRIVATE_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".internal", ".intranet", ".corp", ".private", ".localhost", ".test"]

export function isTrustedHost(hostname: string, publicHosts: readonly string[]) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return true
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return publicHosts.includes(host)
}

function json(body: unknown, status: number, kind?: string) {
  const response = Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (kind) response.headers.set(PROXY_ERROR_HEADER, kind)
  return response
}

/** Where the server tells whoever runs it what happens. */
export interface ServerLog {
  /** Something to fix on the command line, said once per cause: a site or host name turned away. */
  warn(message: string): void
  /** A line per API request, with --debug: never headers, credentials or query strings. */
  debug?(message: string): void
}

export interface HandlerOptions {
  config: ServerConfig
  assets: Assets
  version: string
  /** Signs proxy tokens for the same-origin app; random per process by default. */
  proxySecret?: string
  /** Reaches backends: through an HTTP proxy or with an extra CA, say. The global fetch by default. */
  fetch?: typeof fetch
  /** Reaches a backend without checking its certificate, for connections set to skip the check. */
  fetchSkippingVerify?: typeof fetch
  log?: ServerLog
}

export type ServerHandler = (request: Request, clientIp?: string) => Promise<Response>

/** What an allowed site may call: whether this is a Cardinal server, a proxy token and the proxy. */
function crossOriginPath(path: string) {
  return path === SERVER_INFO_PATH || path === PROXY_TOKEN_PATH || path.startsWith(`${PROXY_PREFIX}/`)
}

const CORS_REQUEST_HEADERS = [...FORWARDED_REQUEST_HEADERS, PROXY_TARGET_HEADER, PROXY_TOKEN_HEADER, PROXY_SKIP_VERIFY_HEADER, CLIENT_HEADER].map((name) => name.toLowerCase()).join(", ")

function preflight(request: Request, origin: string) {
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
    "Access-Control-Allow-Headers": CORS_REQUEST_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  })
  // Chrome's Private Network Access preflight, for a public page calling this machine.
  if (request.headers.get("Access-Control-Request-Private-Network") === "true") headers.set("Access-Control-Allow-Private-Network", "true")
  return new Response(null, { status: 204, headers })
}

/** The backend a proxy request is for, without credentials or query: `http://prometheus:9090/api/v1/query`. */
function backendOf(request: Request, path: string) {
  try {
    const target = new URL(request.headers.get(PROXY_TARGET_HEADER) ?? "")
    const unchecked = skipsVerify(request, target) ? " (certificate not checked)" : ""
    return `${target.origin}${target.pathname.replace(/\/+$/, "")}${path.slice(PROXY_PREFIX.length)}${unchecked}`
  } catch {
    return `(no target) ${path}`
  }
}

/** Why a request failed, in a line: the proxy's own error, or the start of the backend's. */
async function failureOf(response: Response) {
  const kind = response.headers.get(PROXY_ERROR_HEADER)
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim()
  let message = text
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body.error === "string") message = body.error
  } catch {
    // Not JSON: the backend's text as it is.
  }
  const short = message.length > 200 ? `${message.slice(0, 200)}…` : message
  return [kind ? `[${kind}]` : "", short].filter(Boolean).join(" ")
}

function withCors(response: Response, origin: string) {
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", origin)
  headers.append("Vary", "Origin")
  // Lets the page tell this proxy's own failures apart from the backend's.
  headers.set("Access-Control-Expose-Headers", PROXY_ERROR_HEADER)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function createServerHandler(options: HandlerOptions): ServerHandler {
  const { config, assets, version, log } = options
  const proxySecret = options.proxySecret ?? crypto.randomUUID()
  const warned = new Set<string>()

  function warnOnce(key: string, message: string) {
    if (!log || warned.has(key)) return
    warned.add(key)
    log.warn(message)
  }

  function untrustedHost(request: Request) {
    const host = new URL(request.url).hostname
    if (isTrustedHost(host, config.publicHosts)) return null
    warnOnce(`host:${host}`, `Turned away requests for ${host}. If this server is reached by that name, start it with --public-hosts ${host}.`)
    return json({ error: `This server was reached as ${host}. If that is right, start it with --public-hosts ${host} (or CARDINAL_PUBLIC_HOSTS).` }, 403, "public-host")
  }

  async function route(request: Request, ip: string): Promise<Response> {
    const path = new URL(request.url).pathname

    if (path === "/api/sessions" || path.startsWith("/api/sessions/") || path === "/mcp" || path.startsWith("/mcp/")) {
      return json({ error: AGENT_UNAVAILABLE }, 501)
    }

    if (path === SERVER_INFO_PATH) {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405)
      const info: ServerInfo = { kind: "cardinal-server", version, agentSessions: false }
      return json(info, 200)
    }

    if (path === PROXY_TOKEN_PATH) return untrustedHost(request) ?? json(await issueProxyToken(proxySecret, ip), 200)

    if (path.startsWith(`${PROXY_PREFIX}/`)) {
      const denied = untrustedHost(request)
      if (denied) return denied
      if (!(await verifyProxyToken(proxySecret, request.headers.get(PROXY_TOKEN_HEADER) ?? "", ip))) {
        return proxyError(401, "Missing or expired proxy token", "token")
      }
      return forwardProxyRequest(request, {
        allowHosts: config.allowHosts,
        timeoutMs: config.proxyTimeout * 1000,
        fetch: options.fetch,
        fetchSkippingVerify: options.fetchSkippingVerify,
      })
    }

    return json({ error: "Not found" }, 404)
  }

  async function api(request: Request, path: string, origin: string | null, clientIp: string) {
    const allowed = origin !== null && config.allowOrigins.includes(origin) && crossOriginPath(path) ? origin : null
    if (allowed) {
      if (request.method === "OPTIONS") return untrustedHost(request) ?? preflight(request, allowed)
      return withCors(await route(request, clientIp), allowed)
    }
    // Only the app this server serves: other origins, scripts and curl are refused.
    if (!isSameOrigin(request)) {
      if (origin !== null && origin !== new URL(request.url).origin && crossOriginPath(path)) {
        warnOnce(`origin:${origin}`, `Turned away ${origin}. To let it use this server as its proxy, start it with --allow-origin ${origin}.`)
      }
      return json({ error: "Only the Cardinal app served here can use this server" }, 403)
    }
    return route(request, clientIp)
  }

  return async (request, clientIp = "unknown") => {
    const path = new URL(request.url).pathname
    if (path === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } })
    if (!path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/mcp/")) return serveStatic(request, assets)
    const origin = request.headers.get("Origin")
    const started = performance.now()
    const response = await api(request, path, origin, clientIp)
    if (log?.debug) {
      const what = path.startsWith(`${PROXY_PREFIX}/`) ? backendOf(request, path) : path
      const from = origin !== null && origin !== new URL(request.url).origin ? ` from ${origin}` : ""
      const line = `${request.method} ${what} ${response.status} ${Math.round(performance.now() - started)}ms${from}`
      // Read from a copy, so the page gets the body as it streams.
      const failed = response.status >= 400 ? response.clone() : null
      void (failed ? failureOf(failed) : Promise.resolve("")).then((why) => log.debug?.(why ? `${line}: ${why}` : line))
    }
    return response
  }
}
