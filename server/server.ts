import { forwardProxyRequest, proxyError } from "../lib/proxy/core"
import { PROXY_ERROR_HEADER, PROXY_PREFIX, PROXY_TOKEN_HEADER, PROXY_TOKEN_PATH, SERVER_INFO_PATH, type ServerInfo } from "../lib/sources/proxy-constants"
import { isSameOrigin, issueProxyToken, verifyProxyToken } from "../worker/guard"
import type { ServerConfig } from "./config"
import { serveStatic, type Assets } from "./static"

// The self-hosted `cardinal` server: the app plus the same /api/proxy contract
// as the hosted Worker, except that private hosts are allowed. Only the app it
// serves may use the proxy: requests must be same-origin and carry a proxy
// token, and the Host must be localhost, an IP, a non-public name (.local,
// .lan, single-label…) or listed in --public-hosts, so a DNS-rebinding page
// posing as this origin can't use it. Other origins get no CORS headers.

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

export interface HandlerOptions {
  config: ServerConfig
  assets: Assets
  version: string
  /** Signs proxy tokens for the same-origin app; random per process by default. */
  proxySecret?: string
  /** For tests. */
  fetch?: typeof fetch
}

export type ServerHandler = (request: Request, clientIp?: string) => Promise<Response>

export function createServerHandler(options: HandlerOptions): ServerHandler {
  const { config, assets, version } = options
  const proxySecret = options.proxySecret ?? crypto.randomUUID()

  function untrustedHost(request: Request) {
    const host = new URL(request.url).hostname
    return isTrustedHost(host, config.publicHosts)
      ? null
      : json({ error: `This server was reached as ${host}. If that is right, start it with --public-hosts ${host} (or CARDINAL_PUBLIC_HOSTS).` }, 403, "public-host")
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
      return forwardProxyRequest(request, { blockPrivate: false, allowHosts: config.allowHosts, fetch: options.fetch })
    }

    return json({ error: "Not found" }, 404)
  }

  return async (request, clientIp = "unknown") => {
    const path = new URL(request.url).pathname
    if (path === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } })
    if (!path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/mcp/")) return serveStatic(request, assets)
    // Only the app this server serves: other origins, scripts and curl are refused.
    if (!isSameOrigin(request)) return json({ error: "Only the Cardinal app served here can use this server" }, 403)
    return route(request, clientIp)
  }
}
