import { forwardProxyRequest, proxyError } from "../lib/proxy/core"
import {
  CLIENT_HEADER,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
  PROXY_TARGET_HEADER,
  PROXY_TOKEN_HEADER,
  PROXY_TOKEN_PATH,
  RELAY_INFO_PATH,
  RELAY_TOKEN_HEADER,
  type RelayInfo,
} from "../lib/sources/proxy-constants"
import { isSameOrigin, issueProxyToken, verifyProxyToken } from "../worker/guard"
import type { RelayConfig } from "./config"
import { serveStatic, type Assets } from "./static"

// The self-hosted `cardinal` server: the app, the same /api/proxy contract as
// the hosted Worker (private hosts allowed), and a relay for other origins.
//
// Who may use the proxy:
// - Same-origin pages (the app served here), with a proxy token like the
//   Worker. Their Host must be localhost, an IP, a non-public name (.local,
//   .lan, single-label…) or listed in --public-hosts, so a DNS-rebinding page
//   posing as this origin can't use it.
// - Cross-origin pages only from allowed origins (CORS) and only with the
//   relay token. Other origins get no CORS headers, so browsers block them.
// - Non-browser clients (no Origin) with the relay token.

export const AGENT_UNAVAILABLE =
  "Agent sessions need the hosted app at https://cardinal.ta3.dev. Use it with Relay mode to reach backends on your network."

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS"
const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "if-match",
  "x-scope-orgid",
  PROXY_TARGET_HEADER,
  RELAY_TOKEN_HEADER,
  CLIENT_HEADER,
]
  .map((name) => name.toLowerCase())
  .join(", ")
const EXPOSED_HEADERS = [PROXY_ERROR_HEADER, "ETag", "Last-Modified"].join(", ")

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

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

/** Compares SHA-256 digests byte by byte without an early exit, so timing reveals nothing about the token. */
export async function tokensMatch(given: string, expected: string) {
  const [a, b] = await Promise.all([digest(given), digest(expected)])
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index]
  return diff === 0 && expected.length > 0
}

type Access =
  | { kind: "same-origin" }
  | { kind: "cross-origin"; origin: string }
  /** A browser page on an origin that isn't allowed. */
  | { kind: "forbidden"; origin: string }
  /** No Origin and no same-origin proof: curl, scripts. */
  | { kind: "other" }

function classify(request: Request, config: RelayConfig): Access {
  if (isSameOrigin(request)) return { kind: "same-origin" }
  const origin = request.headers.get("Origin")
  if (origin === null) return { kind: "other" }
  return config.origins.includes(origin) ? { kind: "cross-origin", origin } : { kind: "forbidden", origin }
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    Vary: "Origin",
  }
}

function json(body: unknown, status: number, kind?: string) {
  const response = Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (kind) response.headers.set(PROXY_ERROR_HEADER, kind)
  return response
}

export interface HandlerOptions {
  config: RelayConfig
  assets: Assets
  version: string
  /** Signs proxy tokens for the same-origin app; random per process by default. */
  proxySecret?: string
  /** For tests. */
  fetch?: typeof fetch
  log?: (message: string) => void
}

export type RelayHandler = (request: Request, clientIp?: string) => Promise<Response>

export function createRelayHandler(options: HandlerOptions): RelayHandler {
  const { config, assets, version } = options
  const proxySecret = options.proxySecret ?? crypto.randomUUID()
  const reported = new Set<string>()

  function refuse(origin: string) {
    if (!reported.has(origin) && reported.size < 50) {
      reported.add(origin)
      options.log?.(`Refused a request from ${origin}. To allow it as a relay origin, start with --origin ${origin}`)
    }
    // No CORS headers: the browser reports a network error to the page.
    return json({ error: `Origin ${origin} is not allowed to use this relay` }, 403, "origin")
  }

  function untrustedHost(request: Request) {
    const host = new URL(request.url).hostname
    return isTrustedHost(host, config.publicHosts)
      ? null
      : json({ error: `This server was reached as ${host}. If that is right, start it with --public-hosts ${host} (or CARDINAL_PUBLIC_HOSTS).` }, 403, "public-host")
  }

  async function relayTokenValid(request: Request) {
    return tokensMatch(request.headers.get(RELAY_TOKEN_HEADER) ?? "", config.relayToken)
  }

  async function route(request: Request, access: Exclude<Access, { kind: "forbidden" }>, ip: string): Promise<Response> {
    const path = new URL(request.url).pathname
    const sameOrigin = access.kind === "same-origin"

    if (path === "/api/sessions" || path.startsWith("/api/sessions/") || path === "/mcp" || path.startsWith("/mcp/")) {
      return json({ error: AGENT_UNAVAILABLE }, 501)
    }

    if (path === RELAY_INFO_PATH) {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405)
      if (!sameOrigin && !(await relayTokenValid(request))) return json({ error: "Missing or wrong relay token" }, 401, "relay-token")
      const info: RelayInfo = { kind: "cardinal-server", version, agentSessions: false, mode: sameOrigin ? "self-hosted" : "relay" }
      return json(info, 200)
    }

    if (path === PROXY_TOKEN_PATH) {
      if (!sameOrigin) return json({ error: "Forbidden" }, 403)
      return untrustedHost(request) ?? json(await issueProxyToken(proxySecret, ip), 200)
    }

    if (path.startsWith(`${PROXY_PREFIX}/`)) {
      if (sameOrigin) {
        const denied = untrustedHost(request)
        if (denied) return denied
        if (!(await verifyProxyToken(proxySecret, request.headers.get(PROXY_TOKEN_HEADER) ?? "", ip))) {
          return proxyError(401, "Missing or expired proxy token", "token")
        }
      } else if (!(await relayTokenValid(request))) {
        return proxyError(401, "Missing or wrong relay token", "relay-token")
      }
      return forwardProxyRequest(request, { blockPrivate: false, allowHosts: config.allowHosts, fetch: options.fetch })
    }

    return json({ error: "Not found" }, 404)
  }

  return async (request, clientIp = "unknown") => {
    const path = new URL(request.url).pathname
    if (path === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } })
    if (!path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/mcp/")) return serveStatic(request, assets)

    const access = classify(request, config)
    if (access.kind === "forbidden") return refuse(access.origin)

    if (request.method === "OPTIONS") {
      if (access.kind !== "cross-origin") return new Response(null, { status: 403 })
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(access.origin),
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": ALLOWED_HEADERS,
          // Chrome's Private Network Access preflight asked for this; Local Network Access
          // (its successor, a permission prompt) ignores it, so it is harmless to always send.
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Max-Age": "600",
        },
      })
    }

    const response = await route(request, access, clientIp)
    if (access.kind !== "cross-origin") return response
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(corsHeaders(access.origin))) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
