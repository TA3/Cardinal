import {
  CLIENT_HEADER,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
  PROXY_TARGET_HEADER,
  PROXY_TOKEN_HEADER,
  PROXY_TOKEN_PATH,
  RELAY_INFO_PATH,
  RELAY_TOKEN_HEADER,
  isLoopbackHost,
  isPrivateHost,
  isRelayInfo,
  type RelayInfo,
} from "@/lib/sources/proxy-constants"

// The only place the transport modes differ. Direct mode calls the backend
// from the browser (needs CORS); proxy mode goes through the server that
// serves this page at /api/proxy (the Cardinal Worker, or a self-hosted
// `cardinal` server), which forwards credentials without storing them. Relay
// mode calls /api/proxy on a self-hosted `cardinal` server elsewhere (see
// configureRelay), which can reach backends on the user's network.

export type TransportMode = "direct" | "proxy" | "relay"

/**
 * How requests authenticate. "mimir" sends the tenant as X-Scope-OrgID plus
 * optional credentials: Basic when a username is set, Bearer when only a token is.
 */
export type AuthMode = "none" | "basic" | "bearer" | "grafana-cloud" | "mimir"

export interface Connection {
  baseUrl: string
  /** Undefined on connections from before auth modes existed: inferred from the fields. */
  auth?: AuthMode
  /** Basic auth username, or the Grafana Cloud instance ID. */
  instanceId?: string
  /** Password, bearer token or Grafana Cloud access policy token. */
  token?: string
  /** Mimir / Cortex tenant, sent as X-Scope-OrgID. */
  tenant?: string
  mode: TransportMode
}

export interface HttpRequest {
  path: string
  query?: Record<string, string | string[]>
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** The browser refused or failed the request (direct mode): CORS, DNS, TLS or a refused connection look the same. */
export class CorsError extends Error {
  constructor(
    readonly target: string,
    cause?: unknown
  ) {
    super(
      `The browser could not reach ${target}. Either the backend does not allow cross-origin requests (CORS) or the host is unreachable.`,
      { cause }
    )
    this.name = "CorsError"
  }
}

/** Why the Cardinal proxy itself failed, from its X-Cardinal-Proxy-Error header. */
export type ProxyFailure =
  | "token"
  | "dns"
  | "timeout"
  | "unreachable"
  | "private"
  | "path"
  | "redirect"
  /** Self-hosted server only: a target outside --allow-hosts. */
  | "host"
  /** Self-hosted server only: reached under a host name it doesn't trust (--public-hosts). */
  | "public-host"
  /** Relay mode: the relay token is missing or wrong. */
  | "relay-token"

function authHint(status: number, auth: AuthMode, detail: string) {
  if (/no org id/i.test(detail)) {
    return "The backend is multi-tenant and wants a tenant: choose Mimir tenant and set X-Scope-OrgID."
  }
  const denied = status === 403
  switch (auth) {
    case "none":
      return "The backend requires credentials. Choose an auth mode and enter them."
    case "basic":
      return denied ? "The user is known but not allowed to read this API." : "Check the username and password."
    case "bearer":
      return denied ? "The token is valid but lacks permission for this API." : "Check the bearer token; it may be wrong or expired."
    case "grafana-cloud":
      return denied
        ? "The access policy token is missing a scope: it needs metrics:read (Adaptive Metrics also needs its own scopes)."
        : "Check the instance ID (the numeric user on the stack's Prometheus details page) and the access policy token."
    case "mimir":
      return denied ? "The credentials are not allowed to read this tenant. Check X-Scope-OrgID." : "Check the credentials sent with the tenant."
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
    options: { auth?: AuthMode; baseUrl?: string; proxyFailure?: ProxyFailure | null } = {}
  ) {
    const auth = options.auth ?? "none"
    super(
      options.proxyFailure && options.proxyFailure !== "token" && options.proxyFailure !== "relay-token"
        ? detailMessage(detail) || `The Cardinal proxy failed (HTTP ${status})`
        : options.proxyFailure === "relay-token"
          ? "The relay refused its token. Copy the token the relay printed at startup into Settings → Relay."
          : status === 401 || status === 403
          ? `Authentication failed (HTTP ${status}). ${authHint(status, auth, detail)}`
          : status === 404
            ? `Nothing at ${options.baseUrl ?? ""}${path} (HTTP 404). Check the URL path${
                options.baseUrl && isGrafanaCloudHost(options.baseUrl) && !/\/api\/prom\/?$/.test(options.baseUrl)
                  ? ": Grafana Cloud URLs end in /api/prom"
                  : ""
              }.`
            : `Request to ${path} failed with HTTP ${status}${detail ? `: ${detailMessage(detail)}` : ""}`
    )
    this.name = "HttpError"
    this.proxyFailure = options.proxyFailure ?? null
  }

  readonly proxyFailure: ProxyFailure | null
}

/** The error text inside a JSON error body ({error: "..."}), or the raw text. */
function detailMessage(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { error?: unknown; message?: unknown }
    const message = parsed.error ?? parsed.message
    if (typeof message === "string") return message
  } catch {
    // not JSON
  }
  return detail
}

export function normalizeBaseUrl(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error("URL must start with http:// or https://")
  }
  return trimmed
}

export function isGrafanaCloudHost(url: string) {
  try {
    return /(^|\.)grafana\.net$/i.test(new URL(url.trim()).hostname)
  } catch {
    return /\.grafana\.net/i.test(url)
  }
}

/** Auth mode for settings saved before auth modes existed. */
export function inferAuthMode(fields: { baseUrl: string; instanceId?: string; token?: string; tokenExpected?: boolean }): AuthMode {
  if (fields.instanceId?.trim()) return isGrafanaCloudHost(fields.baseUrl) ? "grafana-cloud" : "basic"
  if (fields.token?.trim() || fields.tokenExpected) return "bearer"
  return "none"
}

function basic(user: string, password: string) {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  return `Basic ${btoa(String.fromCharCode(...bytes))}`
}

/** Authorization and tenant headers for a connection. Throws when a required credential is missing. */
export function authHeaders(connection: Connection): Record<string, string> {
  const auth = connection.auth ?? inferAuthMode(connection)
  const user = connection.instanceId?.trim() ?? ""
  const token = connection.token?.trim() ?? ""
  const headers: Record<string, string> = {}
  switch (auth) {
    case "none":
      break
    case "basic":
      if (!user && !token) throw new Error("Basic auth needs a username and password.")
      headers.Authorization = basic(user, token)
      break
    case "bearer":
      if (!token) throw new Error("Bearer auth needs a token.")
      headers.Authorization = `Bearer ${token}`
      break
    case "grafana-cloud":
      if (!user || !token) throw new Error("Grafana Cloud needs the instance ID and an access policy token.")
      headers.Authorization = basic(user, token)
      break
    case "mimir": {
      const tenant = connection.tenant?.trim()
      if (!tenant) throw new Error("Mimir tenant mode needs a tenant ID (X-Scope-OrgID).")
      headers["X-Scope-OrgID"] = tenant
      if (user) headers.Authorization = basic(user, token)
      else if (token) headers.Authorization = `Bearer ${token}`
      break
    }
  }
  return headers
}

function appendQuery(url: URL, query: HttpRequest["query"]) {
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, item)
    }
  }
}

function appOrigin() {
  return globalThis.location?.origin ?? "http://localhost"
}

// Proxy mode needs a short-lived token from the Worker. One fetch is shared by
// concurrent requests, and it is refreshed a minute before expiry or on 401.
export class ProxyTokenError extends Error {
  constructor(readonly status: number) {
    super(`Could not get a Cardinal proxy token (HTTP ${status})`)
    this.name = "ProxyTokenError"
  }
}

let proxyToken: { token: string; expiresAt: number } | null = null
let proxyTokenRequest: Promise<string> | null = null

async function fetchProxyToken() {
  const response = await fetch(new URL(PROXY_TOKEN_PATH, appOrigin()), { cache: "no-store", headers: { [CLIENT_HEADER]: "1" } })
  if (!response.ok) throw new ProxyTokenError(response.status)
  const body = (await response.json()) as { token: string; expiresAt: string }
  proxyToken = { token: body.token, expiresAt: new Date(body.expiresAt).getTime() }
  return body.token
}

function getProxyToken(force = false): Promise<string> {
  if (!force && proxyToken && proxyToken.expiresAt - Date.now() > 60_000) return Promise.resolve(proxyToken.token)
  if (force) proxyToken = null
  proxyTokenRequest ??= fetchProxyToken().finally(() => {
    proxyTokenRequest = null
  })
  return proxyTokenRequest
}

/** Where Relay mode sends requests: a self-hosted `cardinal` server and its relay token. */
export interface RelayTarget {
  url: string
  token: string
}

let relayTarget: RelayTarget | null = null

/** Set by the relay settings store; null turns Relay mode off. */
export function configureRelay(target: RelayTarget | null) {
  const url = target?.url.trim().replace(/\/+$/, "") ?? ""
  relayTarget = url ? { url, token: target?.token.trim() ?? "" } : null
}

/** Why the browser couldn't use the relay. A wrong token surfaces as HttpError with proxyFailure "relay-token". */
export type RelayFailure = "not-configured" | "invalid-url" | "mixed-content" | "permission" | "origin" | "unreachable" | "token" | "not-cardinal"

function relayMessage(kind: RelayFailure, relayUrl: string) {
  const origin = appOrigin()
  switch (kind) {
    case "not-configured":
      return "Relay mode needs a relay: set its URL and token in Settings → Relay."
    case "invalid-url":
      return `The relay URL isn't valid: ${relayUrl}`
    case "mixed-content":
      return `This page is HTTPS, so the browser blocks the plain-http relay at ${relayUrl}. Run the relay on this machine (http://localhost), or put HTTPS in front of it.`
    case "permission":
      return "This site isn't allowed to reach your local network. Allow Local network access in the site settings (the icon left of the address bar), then try again."
    case "origin":
      return `The relay at ${relayUrl} answered but doesn't allow ${origin}. Start it with --origin ${origin} (or CARDINAL_ORIGINS).`
    case "unreachable":
      return `Can't reach the relay at ${relayUrl}. Check that it is running and the URL and port are right.`
    case "token":
      return "The relay refused its token. Copy the token the relay printed at startup."
    case "not-cardinal":
      return `${relayUrl} answered, but it isn't a Cardinal server.`
  }
}

export class RelayError extends Error {
  constructor(
    readonly kind: RelayFailure,
    readonly relayUrl: string,
    cause?: unknown
  ) {
    super(relayMessage(kind, relayUrl), { cause })
    this.name = "RelayError"
  }
}

/** Chrome's Local Network Access (Chrome 142+) adds `targetAddressSpace` to fetch. */
function supportsLocalNetworkAccess() {
  return typeof Request !== "undefined" && "targetAddressSpace" in Request.prototype
}

/**
 * Fetch options for a request to the relay. An HTTPS page may call a plain-http
 * relay on the local network only when the fetch says so (Local Network
 * Access exempts it from mixed-content blocking); loopback is always allowed.
 */
function relayInit(relayUrl: URL, init: RequestInit): RequestInit {
  if (globalThis.location?.protocol !== "https:" || relayUrl.protocol !== "http:" || isLoopbackHost(relayUrl.hostname)) return init
  return { ...init, targetAddressSpace: "local" } as RequestInit
}

async function localNetworkDenied(relayUrl: URL) {
  const names = isLoopbackHost(relayUrl.hostname) ? ["loopback-network", "local-network-access"] : ["local-network", "local-network-access"]
  for (const name of names) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName })
      if (status.state === "denied") return true
      return false
    } catch {
      // Unknown permission name in this browser: try the next one.
    }
  }
  return false
}

/** Turns a failed fetch to the relay into the reason, probing without CORS like probeReachable. */
async function relayNetworkError(relayUrl: string, cause: unknown): Promise<RelayError> {
  let url: URL
  try {
    url = new URL(relayUrl)
  } catch {
    return new RelayError("invalid-url", relayUrl, cause)
  }
  if (await localNetworkDenied(url).catch(() => false)) return new RelayError("permission", relayUrl, cause)
  const mixed = globalThis.location?.protocol === "https:" && url.protocol === "http:" && !isLoopbackHost(url.hostname)
  if (mixed && (!supportsLocalNetworkAccess() || !isPrivateHost(url.hostname))) return new RelayError("mixed-content", relayUrl, cause)
  try {
    await fetch(new URL("/healthz", url), relayInit(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(5_000) }))
    // It answers, but the CORS request failed: the relay didn't allow this origin.
    return new RelayError("origin", relayUrl, cause)
  } catch {
    return new RelayError("unreachable", relayUrl, cause)
  }
}

function isAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

/** Tests a relay: reachable, this origin allowed, token right. */
export async function fetchRelayInfo(target: RelayTarget, signal?: AbortSignal): Promise<RelayInfo & { latencyMs: number }> {
  const base = target.url.trim().replace(/\/+$/, "")
  if (!base) throw new RelayError("not-configured", base)
  let url: URL
  try {
    url = new URL(`${base}${RELAY_INFO_PATH}`)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http")
  } catch {
    throw new RelayError("invalid-url", base)
  }
  const started = performance.now()
  let response: Response
  try {
    response = await fetch(url, relayInit(url, { headers: { [RELAY_TOKEN_HEADER]: target.token.trim() }, cache: "no-store", signal }))
  } catch (error) {
    if (isAbort(error)) throw error
    throw await relayNetworkError(base, error)
  }
  if (response.status === 401) throw new RelayError("token", base)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !isRelayInfo(body)) throw new RelayError("not-cardinal", base)
  return { ...body, latencyMs: Math.round(performance.now() - started) }
}

/** The self-hosted server's info when it serves this page; null on the hosted app or in dev. */
export async function detectSelfHosted(signal?: AbortSignal): Promise<RelayInfo | null> {
  try {
    const response = await fetch(new URL(RELAY_INFO_PATH, appOrigin()), { headers: { [CLIENT_HEADER]: "1" }, cache: "no-store", signal })
    const body: unknown = response.ok ? await response.json() : null
    return isRelayInfo(body) ? body : null
  } catch {
    return null
  }
}

export async function send(connection: Connection, request: HttpRequest): Promise<Response> {
  const baseUrl = normalizeBaseUrl(connection.baseUrl)
  const headers: Record<string, string> = { ...authHeaders(connection), ...request.headers }
  if (request.body !== undefined) headers["Content-Type"] = "application/json"

  let url: URL
  const relay = connection.mode === "relay" ? relayTarget : null
  if (connection.mode === "proxy") {
    url = new URL(`${PROXY_PREFIX}${request.path}`, appOrigin())
    headers[PROXY_TARGET_HEADER] = baseUrl
    headers[CLIENT_HEADER] = "1"
  } else if (connection.mode === "relay") {
    if (!relay) throw new RelayError("not-configured", "")
    try {
      url = new URL(`${relay.url}${PROXY_PREFIX}${request.path}`)
    } catch {
      throw new RelayError("invalid-url", relay.url)
    }
    headers[PROXY_TARGET_HEADER] = baseUrl
    headers[RELAY_TOKEN_HEADER] = relay.token
  } else {
    url = new URL(`${baseUrl}${request.path}`)
  }
  appendQuery(url, request.query)

  const attempt = async (refreshToken: boolean) => {
    if (connection.mode === "proxy") headers[PROXY_TOKEN_HEADER] = await getProxyToken(refreshToken)
    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      cache: "no-store",
      signal: request.signal,
    }
    return fetch(url, relay ? relayInit(url, init) : init)
  }

  let response: Response
  try {
    response = await attempt(false)
    // The proxy's own 401 (token expired, or minted by another isolate): refresh once.
    if (response.status === 401 && response.headers.get(PROXY_ERROR_HEADER) === "token") {
      await response.body?.cancel().catch(() => undefined)
      response = await attempt(true)
    }
  } catch (error) {
    if (isAbort(error)) throw error
    if (error instanceof ProxyTokenError) throw error
    if (connection.mode === "direct") throw new CorsError(`${baseUrl}${request.path}`, error)
    if (relay) throw await relayNetworkError(relay.url, error)
    throw new Error(`Network error: could not reach the Cardinal proxy (${String(error)})`, { cause: error })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const proxyFailure = connection.mode !== "direct" ? (response.headers.get(PROXY_ERROR_HEADER) as ProxyFailure | null) : null
    throw new HttpError(response.status, request.path, text.slice(0, 300), {
      auth: connection.auth ?? inferAuthMode(connection),
      baseUrl,
      proxyFailure,
    })
  }
  return response
}

export async function sendJson<T>(connection: Connection, request: HttpRequest): Promise<T> {
  const response = await send(connection, request)
  return (await response.json()) as T
}

/**
 * Direct mode only: tells CORS apart from an unreachable host. A no-cors
 * request gets an opaque response whenever the host answers at all, and fails
 * like the real request only on DNS, refused connections or TLS errors.
 */
export async function probeReachable(url: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}
