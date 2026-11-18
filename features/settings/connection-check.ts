import { testLokiConnection } from "@/lib/sources/loki"
import { isQueryLimitError, testConnection } from "@/lib/sources/prometheus"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import { proxyCommand } from "@/lib/core/own-server"
import {
  CorsError,
  hasProxyServer,
  HttpError,
  isGrafanaCloudHost,
  NoProxyServerError,
  probeReachable,
  ProxyServerError,
  ProxyTokenError,
  supportsLocalNetworkAccess,
} from "@/lib/sources/transport"
import type { ConnectionSettings } from "@/lib/store/app-store"
import { useServerStore } from "@/lib/store/server-store"

// Turns a failed connection test or snapshot into something the user can act
// on: what went wrong, the likely cause and, where there is one, a fix.

export type ProblemKind =
  | "cors"
  | "unreachable"
  | "dns"
  | "mixed-content"
  | "auth"
  | "not-found"
  | "timeout"
  | "limit"
  /** Only the user's own Cardinal server reaches the backend, and this page has none. */
  | "needs-server"
  /** The Cardinal server set as this page's proxy didn't answer or refused this page. */
  | "server"
  | "config"
  | "other"

export interface ConnectionProblem {
  kind: ProblemKind
  title: string
  detail: string
  /** Copyable config, e.g. the Prometheus CORS flag. */
  snippet?: string
  /** A settings change that likely fixes it. */
  fix?: { label: string; patch: Partial<ConnectionSettings> }
  /** "server": the way out is the user's own Cardinal server (run it, then open it or set it as this page's proxy). */
  help?: "server"
  /** A page that works around it, e.g. the local app the user's server serves. */
  link?: { label: string; href: string }
}

export const TEST_TIMEOUT_MS = 10_000

/** A self-signed certificate or an unknown issuer, which skipping the check is for; not an expired or misnamed one. */
function selfSigned(message: string) {
  return /self[- ]signed|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|unable to (verify|get local issuer)/i.test(message)
}

/** The user's Cardinal server didn't trust the certificate of `name` (a backend's host, or "Grafana"). */
export function tlsProblem(error: unknown, name: string): ConnectionProblem | null {
  if (!(error instanceof HttpError) || error.proxyFailure !== "tls") return null
  return {
    kind: "other",
    title: `${name}'s certificate isn't trusted`,
    detail: error.message,
    ...(selfSigned(error.message) ? { fix: { label: "Skip the check", patch: { tlsSkipVerify: true } } } : {}),
  }
}

function hostOf(url: string) {
  try {
    return new URL(url.trim()).host
  } catch {
    return url
  }
}

function isTimeout(error: unknown) {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
}

/** Prometheus' --web.cors.origin takes an anchored regex, so dots need escaping. */
export function corsFlag(origin: string) {
  return `--web.cors.origin='${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`
}

function withApiProm(baseUrl: string) {
  return `${baseUrl.trim().replace(/\/+$/, "")}/api/prom`
}

/**
 * Asks the backend again through the user's own Cardinal server, without
 * credentials, to learn the real status: error pages (404s) rarely carry CORS
 * headers, so in direct mode a wrong path looks exactly like a CORS problem.
 */
async function statusViaProxy(baseUrl: string, api: BackendApi): Promise<number | null> {
  try {
    const connection = { baseUrl: baseUrl.trim(), mode: "proxy", auth: "none" } as const
    const test = api === "loki" ? testLokiConnection : testConnection
    await test(connection, AbortSignal.timeout(TEST_TIMEOUT_MS))
    return 200
  } catch (error) {
    return error instanceof HttpError && !error.proxyFailure ? error.status : null
  }
}

/** Which API the connection is for: Prometheus (metrics) or Loki (logs). */
export type BackendApi = "prometheus" | "loki"

/** Safari (WebKit without Chrome's or Firefox's engines), which blocks loopback from https pages outright. */
function isSafari() {
  const agent = globalThis.navigator?.userAgent ?? ""
  return /Safari\//.test(agent) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|Firefox\/|FxiOS\//.test(agent)
}

/** The page origin, as a Cardinal server's --allow-origin takes it. */
function pageOrigin() {
  return globalThis.location?.origin ?? "http://localhost:5173"
}

/**
 * Problems with the user's own Cardinal server as the proxy: none set on a
 * page no Cardinal server serves, or the one set didn't answer or refused
 * this page. Null for anything else.
 */
export function ownServerProblem(error: unknown): ConnectionProblem | null {
  if (error instanceof NoProxyServerError) {
    const host = hostOf(error.target)
    return {
      kind: "needs-server",
      title: isGrafanaCloudHost(error.target)
        ? "Grafana Cloud blocks browser requests: reach it through your own Cardinal server"
        : `${host} blocks browser requests: reach it through your own Cardinal server`,
      detail:
        "Cardinal's hosted app has no proxy. Run Cardinal on your machine with one command, then open it, or set it as this page's proxy. Your token and queries go from your machine straight to the backend.",
      snippet: proxyCommand(pageOrigin()),
      help: "server",
    }
  }
  if (error instanceof ProxyServerError) {
    const host = hostOf(error.server)
    const open = { label: `Open ${host}`, href: error.server }
    if (error.access === "denied") {
      return {
        kind: "server",
        title: `Your browser doesn't let this page reach ${host}`,
        detail: `Allow ${hostOf(pageOrigin())} to reach apps on this device (local network access) in the browser's site settings, then try again. Or open the app your server serves, which needs no permission.`,
        link: open,
        help: "server",
      }
    }
    const safari = error.access === "unsupported" && isSafari()
    if (safari && new URL(error.server).protocol === "http:") {
      return {
        kind: "server",
        title: `Safari doesn't let https pages reach ${host}`,
        detail:
          "Safari blocks http://localhost from https pages, with no way to allow it. Open the app your server serves instead, or start it with --tls-cert and --tls-key (a certificate this Mac trusts) and use its https:// address.",
        link: open,
        help: "server",
      }
    }
    return {
      kind: "server",
      title: `Couldn't reach your Cardinal server at ${host}`,
      detail: `Start it on this machine with the command below, which lets ${pageOrigin()} use it, then try again. If it runs and still fails, its terminal says why (add --debug for every request), or open the app it serves instead${
        error.access === "prompt" ? ". The browser may also be asking to let this site reach your device" : ""
      }.`,
      snippet: proxyCommand(pageOrigin()),
      link: open,
      help: "server",
    }
  }
  return null
}

export async function diagnose(error: unknown, draft: ConnectionSettings, api: BackendApi = "prometheus"): Promise<ConnectionProblem> {
  const host = hostOf(draft.baseUrl)
  const origin = globalThis.location?.origin ?? "http://localhost:5173"
  const { server } = useServerStore.getState()

  const serverProblem = ownServerProblem(error)
  if (serverProblem) return serverProblem

  if (isTimeout(error)) {
    return {
      kind: "timeout",
      title: `${host} did not answer in ${TEST_TIMEOUT_MS / 1000} s`,
      detail: "The server may be overloaded, behind a firewall or VPN, or the URL may point at the wrong port.",
    }
  }

  if (error instanceof CorsError) {
    let target: URL | null = null
    try {
      target = new URL(draft.baseUrl.trim())
    } catch {
      // handled below
    }
    const privateHost = target ? isPrivateHost(target.hostname) : false
    // The user's own Cardinal server: the one serving this page, or the one set as its proxy.
    const ownServer = Boolean(server) || hasProxyServer()
    const useServer = { label: server ? "Use this server" : "Use your server", patch: { mode: "proxy" as const } }
    if (isGrafanaCloudHost(draft.baseUrl) && !ownServer) return ownServerProblem(new NoProxyServerError(draft.baseUrl))!
    if (target && globalThis.location?.protocol === "https:" && target.protocol === "http:" && privateHost && !supportsLocalNetworkAccess() && !ownServer) {
      return {
        kind: "mixed-content",
        title: "This browser blocks http:// on your network from an https page",
        detail: "Use Chrome 142 or later (it asks to allow local network access), or go through your own Cardinal server.",
        help: "server",
      }
    }
    if (target && globalThis.location?.protocol === "https:" && target.protocol === "http:" && !privateHost) {
      return {
        kind: "mixed-content",
        title: "The browser blocks plain-HTTP backends from an HTTPS page",
        detail: "Use an https:// URL for the backend, or go through your own Cardinal server.",
        ...(ownServer ? { fix: useServer } : { help: "server" as const }),
      }
    }
    if (!(await probeReachable(draft.baseUrl.trim()))) {
      return {
        kind: "unreachable",
        title: `Can't reach ${host}`,
        detail: privateHost
          ? "The name doesn't resolve (DNS), nothing listens on that port, or the certificate isn't trusted. Check the URL from this machine, e.g. with curl."
          : "The name doesn't resolve (DNS), the connection was refused, or the TLS certificate is invalid. Check the URL for typos.",
      }
    }
    if (ownServer) {
      // Error pages (404s) rarely carry CORS headers: ask through the server whether the path is right.
      const status = await statusViaProxy(draft.baseUrl, api)
      if (status === 404) return diagnose(new HttpError(404, api === "loki" ? "/loki/api/v1/labels" : "/api/v1/query", "", { baseUrl: draft.baseUrl.trim() }), draft, api)
      return {
        kind: "cors",
        title: `${host} blocks browser requests (CORS)`,
        detail: `Your Cardinal server needs no CORS: route requests through it${status === 200 ? " (it reaches this backend)" : ""}.`,
        fix: useServer,
      }
    }
    return {
      kind: "cors",
      title: `${host} blocks browser requests (CORS)`,
      help: "server",
      detail:
        api === "loki"
          ? "Go through your own Cardinal server (it needs no CORS), or allow this origin in the proxy in front of Loki: send Access-Control-Allow-Origin for it and allow the Authorization and X-Scope-OrgID headers on OPTIONS preflights."
          : "Go through your own Cardinal server (it needs no CORS), or allow this origin on the backend: for Prometheus, start it with the flag below; for Mimir, Thanos or a reverse proxy, send Access-Control-Allow-Origin for this origin and allow the Authorization and X-Scope-OrgID headers on OPTIONS preflights.",
      ...(api === "loki" ? {} : { snippet: corsFlag(origin) }),
    }
  }

  if (error instanceof ProxyTokenError) {
    return server
      ? {
          kind: "other",
          title: `This Cardinal server refused this page (HTTP ${error.status})`,
          detail: `It doesn't trust the name it was reached by (${globalThis.location?.hostname ?? "this host"}), to guard against DNS rebinding. Restart it with --public-hosts ${globalThis.location?.hostname ?? "<host>"} (or CARDINAL_PUBLIC_HOSTS).`,
        }
      : {
          kind: "server",
          title: `Your Cardinal server refused this page (HTTP ${error.status})`,
          detail: `Restart it with --allow-origin ${origin}, and reach it as localhost, an IP address or a name given with --public-hosts.`,
          snippet: proxyCommand(origin),
          help: "server",
        }
  }

  if (error instanceof HttpError) {
    switch (error.proxyFailure) {
      case "dns":
        return { kind: "dns", title: `${host} doesn't resolve`, detail: "DNS lookup failed. Check the host name for typos." }
      case "timeout":
        return {
          kind: "timeout",
          title: `${host} did not answer in time`,
          detail: "Your Cardinal server gave up waiting. The backend may be down or overloaded; for slow queries, start the server with --proxy-timeout 120.",
        }
      case "tls":
        return tlsProblem(error, host)!
      case "unreachable":
        return {
          kind: "unreachable",
          title: `Can't reach ${host}`,
          detail: `Your Cardinal server couldn't connect: the name may not resolve (DNS) from where it runs, or the host refused the connection. ${error.message}`,
        }
      case "host":
        return {
          kind: "other",
          title: `${host} isn't in the server's host allowlist`,
          detail: `The Cardinal server was started with --allow-hosts (CARDINAL_ALLOW_HOSTS), and ${host} isn't in it. Add it there, then restart the server.`,
        }
      case "public-host":
        return { kind: "other", title: "The Cardinal server doesn't trust the name it was reached by", detail: error.message }
      case "redirect":
        return {
          kind: "not-found",
          title: "The backend redirected the request",
          detail: "That usually means the path is wrong, e.g. a Grafana UI URL instead of the Prometheus query URL.",
        }
      case "path":
      case "token":
      case null:
        break
    }
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "auth",
        title: error.status === 401 ? "Credentials rejected (HTTP 401)" : "Not allowed (HTTP 403)",
        detail: error.message.replace(/^Authentication failed \(HTTP \d+\)\. /, ""),
        ...(draft.authMode === "none" && isGrafanaCloudHost(draft.baseUrl)
          ? { detail: "Grafana Cloud needs credentials: enter the stack's instance ID and an access policy token." }
          : {}),
      }
    }
    if (error.status === 404 && api === "loki") {
      return {
        kind: "not-found",
        title: "No Loki API at this URL (HTTP 404)",
        detail:
          "Use the URL Loki serves /loki/api/v1 under: the Loki root, Grafana Cloud's logs URL (https://logs-prod-….grafana.net), or a Grafana data source proxy URL (<grafana>/api/datasources/proxy/uid/<uid>; see Pick from Grafana).",
      }
    }
    if (error.status === 404) {
      const cloudMissingPrefix = isGrafanaCloudHost(draft.baseUrl) && !/\/api\/prom\/?$/.test(draft.baseUrl.trim())
      return {
        kind: "not-found",
        title: `No Prometheus API at this URL (HTTP 404)`,
        detail: cloudMissingPrefix
          ? "Grafana Cloud's query URL ends in /api/prom (Stack → Prometheus → Details)."
          : "Check the path: Prometheus serves /api/v1 at its root, Mimir usually under /prometheus, Grafana Cloud under /api/prom.",
        fix: cloudMissingPrefix ? { label: "Add /api/prom", patch: { baseUrl: withApiProm(draft.baseUrl) } } : undefined,
      }
    }
    if (isQueryLimitError(error)) {
      return {
        kind: "limit",
        title: "The backend refused the query for its size",
        detail: `${error.message}. Cardinal retries one job at a time; if that also fails, ask your admin to raise the series limit for this tenant.`,
      }
    }
    return { kind: "other", title: `HTTP ${error.status} from ${host}`, detail: error.message }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/URL must start|needs (a|the)|Invalid URL/i.test(message)) {
    return { kind: "config", title: "Check the connection details", detail: message }
  }
  return { kind: "other", title: "Connection failed", detail: message }
}
