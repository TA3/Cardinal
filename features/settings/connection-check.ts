import { testLokiConnection } from "@/lib/sources/loki"
import { isQueryLimitError, testConnection } from "@/lib/sources/prometheus"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import {
  CorsError,
  HttpError,
  isGrafanaCloudHost,
  probeReachable,
  ProxyConsentError,
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
  | "private-proxy"
  | "proxy-consent"
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
  /**
   * "local": the way out is running Cardinal on that network (the binary or Docker).
   * "proxy-consent": the hosted proxy would work, but the user hasn't allowed it.
   */
  help?: "local" | "proxy-consent"
}

export const TEST_TIMEOUT_MS = 10_000

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
 * Asks a public backend again through the proxy, without credentials, to learn
 * the real status: error pages (404s) rarely carry CORS headers, so in direct
 * mode a wrong path looks exactly like a CORS problem.
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

/** Only the hosted proxy reaches this backend, and the user hasn't allowed it yet. */
export function proxyConsentProblem(target: string): ConnectionProblem {
  const host = hostOf(target)
  return {
    kind: "proxy-consent",
    title: isGrafanaCloudHost(target)
      ? `Grafana Cloud blocks browser requests, so ${host} is only reachable through Cardinal's proxy`
      : `${host} blocks browser requests, so it is only reachable through Cardinal's proxy`,
    detail:
      "The proxy forwards each request, with your token, from Cardinal's servers. Nothing is stored or logged, but it does pass through. To keep everything on your machine, run Cardinal locally instead.",
    help: "proxy-consent",
  }
}

export async function diagnose(error: unknown, draft: ConnectionSettings, api: BackendApi = "prometheus"): Promise<ConnectionProblem> {
  const host = hostOf(draft.baseUrl)
  const origin = globalThis.location?.origin ?? "http://localhost:5173"
  const { server } = useServerStore.getState()

  if (error instanceof ProxyConsentError) return proxyConsentProblem(error.target)

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
    if (target && globalThis.location?.protocol === "https:" && target.protocol === "http:" && privateHost && !supportsLocalNetworkAccess()) {
      return {
        kind: "mixed-content",
        title: "This browser blocks http:// on your network from an https page",
        detail: "Use Chrome 142 or later (it asks to allow local network access), or run Cardinal on your machine.",
        help: "local",
      }
    }
    if (target && globalThis.location?.protocol === "https:" && target.protocol === "http:" && !privateHost) {
      return {
        kind: "mixed-content",
        title: "The browser blocks plain-HTTP backends from an HTTPS page",
        detail: "Use an https:// URL for the backend, or route through the Cardinal proxy.",
        fix: { label: "Use the proxy", patch: { mode: "proxy" } },
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
    if (privateHost && server) {
      return {
        kind: "cors",
        title: `${host} blocks browser requests (CORS)`,
        detail: "This Cardinal server can reach hosts on its network, so it needs no CORS: route requests through it.",
        fix: { label: "Use this server", patch: { mode: "proxy" } },
      }
    }
    if (privateHost) {
      return {
        kind: "cors",
        title: `${host} is private: run Cardinal on your network, or allow this origin`,
        help: "local",
        detail:
          "Either run Cardinal on your machine (it needs no CORS), or allow this origin on the backend: for Prometheus, start it with this flag; for Mimir, Thanos or a reverse proxy, send Access-Control-Allow-Origin for this origin and allow the Authorization and X-Scope-OrgID headers on OPTIONS preflights.",
        snippet: corsFlag(origin),
      }
    }
    const status = await statusViaProxy(draft.baseUrl, api)
    if (status === 404) return diagnose(new HttpError(404, api === "loki" ? "/loki/api/v1/labels" : "/api/v1/query", "", { baseUrl: draft.baseUrl.trim() }), draft, api)
    return {
      kind: "cors",
      title: `${host} blocks browser requests (CORS)`,
      detail:
        status === 200
          ? "The backend doesn't allow requests from this origin, but it works through the Cardinal proxy. Turn the proxy on, or allow this origin on the backend (for Prometheus, the flag below)."
          : "The backend doesn't allow requests from this origin. Route through the Cardinal proxy, or allow this origin on the backend (for Prometheus, the flag below).",
      snippet: corsFlag(origin),
      fix: { label: "Use the proxy", patch: { mode: "proxy" } },
    }
  }

  if (error instanceof ProxyTokenError) {
    return {
      kind: "other",
      title: `The Cardinal proxy refused this page (HTTP ${error.status})`,
      detail:
        error.status === 429
          ? "Too many proxy requests from your IP. Wait a minute and try again."
          : server
            ? `This Cardinal server doesn't trust the name it was reached by (${globalThis.location?.hostname ?? "this host"}), to guard against DNS rebinding. Restart it with --public-hosts ${globalThis.location?.hostname ?? "<host>"} (or CARDINAL_PUBLIC_HOSTS).`
            : "The proxy only serves Cardinal's own pages and could not confirm this one. Reload the page; if it keeps happening, use direct mode.",
      fix: server ? undefined : { label: "Use direct mode", patch: { mode: "direct" } },
    }
  }

  if (error instanceof HttpError) {
    switch (error.proxyFailure) {
      case "dns":
        return { kind: "dns", title: `${host} doesn't resolve`, detail: "DNS lookup failed. Check the host name for typos." }
      case "timeout":
        return { kind: "timeout", title: `${host} did not answer in time`, detail: "The proxy gave up after 30 s. The backend may be down or overloaded." }
      case "unreachable":
        return {
          kind: "unreachable",
          title: `Can't reach ${host}`,
          detail: `The proxy couldn't connect: the name may not resolve (DNS), or the host refused the connection. ${error.message}`,
        }
      case "private":
        return {
          kind: "private-proxy",
          title: `${host} is private: run Cardinal on your network, or call it directly`,
          help: "local",
          detail: `${host} is on a private network, which Cardinal's hosted proxy can't reach. Run Cardinal on your machine, or call it directly and allow this origin on the backend (for Prometheus, the flag below).`,
          snippet: corsFlag(origin),
          fix: { label: "Use direct mode", patch: { mode: "direct" } },
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
