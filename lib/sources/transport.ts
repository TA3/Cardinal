import {
  CLIENT_HEADER,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
  PROXY_SKIP_VERIFY_HEADER,
  PROXY_TARGET_HEADER,
  PROXY_TOKEN_HEADER,
  PROXY_TOKEN_PATH,
  SERVER_INFO_PATH,
  isLoopbackHost,
  isPrivateHost,
  isServerInfo,
  type ServerInfo,
} from "@/lib/sources/proxy-constants"

// The only place the transport modes differ. Direct mode calls the backend
// from the browser (needs CORS); proxy mode goes through the user's own
// `cardinal` server at /api/proxy: the one serving this page, or, on the
// hosted app (which has no proxy), the one set as its proxy. It forwards
// credentials without storing them.

export type TransportMode = "direct" | "proxy"

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
  /** Don't check the backend's certificate (self-signed). Only the user's Cardinal server can, so only in proxy mode. */
  tlsSkipVerify?: boolean
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

/** Why the Cardinal server's proxy itself failed, from its X-Cardinal-Proxy-Error header. */
export type ProxyFailure =
  | "token"
  | "dns"
  | "timeout"
  | "unreachable"
  /** The backend's certificate isn't trusted (--proxy-ca, or the connection's Skip certificate check). */
  | "tls"
  | "path"
  | "redirect"
  /** A target outside --allow-hosts. */
  | "host"
  /** Reached under a host name it doesn't trust (--public-hosts). */
  | "public-host"

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
      options.proxyFailure && options.proxyFailure !== "token"
        ? detailMessage(detail) || `Your Cardinal server failed (HTTP ${status})`
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

/**
 * How the filled-in fields are sent: a tenant means Mimir (X-Scope-OrgID), a
 * username means Basic (Grafana Cloud on grafana.net), a lone token Bearer.
 * The connection form uses it instead of asking; settings saved before auth
 * modes existed are read with it too.
 */
export function inferAuthMode(fields: { baseUrl: string; instanceId?: string; token?: string; tenant?: string; tokenExpected?: boolean }): AuthMode {
  if (fields.tenant?.trim()) return "mimir"
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

// Proxy mode needs a short-lived token from the server. One fetch is shared by
// concurrent requests, and it is refreshed a minute before expiry or on 401.
export class ProxyTokenError extends Error {
  constructor(readonly status: number) {
    super(`Your Cardinal server refused a proxy token (HTTP ${status})`)
    this.name = "ProxyTokenError"
  }
}

let proxyToken: { origin: string; token: string; expiresAt: number } | null = null
let proxyTokenRequest: { origin: string; promise: Promise<string> } | null = null

async function fetchProxyToken(origin: string) {
  const url = new URL(PROXY_TOKEN_PATH, origin)
  const response = await fetch(url, localNetworkInit(url, { cache: "no-store", headers: { [CLIENT_HEADER]: "1" } }))
  if (!response.ok) throw new ProxyTokenError(response.status)
  const body = (await response.json()) as { token: string; expiresAt: string }
  proxyToken = { origin, token: body.token, expiresAt: new Date(body.expiresAt).getTime() }
  return body.token
}

function getProxyToken(origin: string, force = false): Promise<string> {
  if (!force && proxyToken?.origin === origin && proxyToken.expiresAt - Date.now() > 60_000) return Promise.resolve(proxyToken.token)
  if (force) proxyToken = null
  if (proxyTokenRequest?.origin !== origin) {
    const promise: Promise<string> = fetchProxyToken(origin).finally(() => {
      if (proxyTokenRequest?.promise === promise) proxyTokenRequest = null
    })
    proxyTokenRequest = { origin, promise }
  }
  return proxyTokenRequest.promise
}

/**
 * Proxy mode with no Cardinal server of the user's own to go through: the
 * hosted app has no proxy. Run `cardinal` on your machine, then open it, or
 * set it as this page's proxy.
 */
export class NoProxyServerError extends Error {
  constructor(readonly target: string) {
    super(
      `Reaching ${hostLabel(target)} needs your own Cardinal server: run it on your machine, then open it there or set it as this page's proxy.`
    )
    this.name = "NoProxyServerError"
  }
}

/**
 * The Cardinal server set as this page's proxy didn't answer, doesn't let this
 * page use it (no --allow-origin), or the browser kept the page from reaching
 * it: `access` is the browser's local network permission at the time.
 */
export class ProxyServerError extends Error {
  constructor(
    readonly server: string,
    cause?: unknown,
    readonly access: LocalAccessState = "unsupported"
  ) {
    super(`Couldn't reach your Cardinal server at ${server}. Is it running, started with --allow-origin ${appOrigin()}?`, { cause })
    this.name = "ProxyServerError"
  }
}

/** A ProxyServerError for `server`, with the browser's permission to reach it. */
async function proxyServerError(server: string, cause: unknown) {
  const host = new URL(server).hostname
  const space = isLoopbackHost(host) ? "loopback" : isPrivateHost(host) ? "local" : null
  return new ProxyServerError(server, cause, space ? await localAccessState(space) : "granted")
}

function hostLabel(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A Cardinal server's address as an origin (http://host:port), or null when it isn't one. */
export function proxyServerOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}

let proxyServer: string | null = null
/** Set by the app store: the user's Cardinal server, the proxy for a page no Cardinal server serves. */
export function configureProxyServer(url: string) {
  proxyServer = proxyServerOrigin(url)
}

/** A Cardinal server is set as this page's proxy. */
export function hasProxyServer() {
  return proxyServer !== null
}

/** Where proxy requests go: the Cardinal server serving this page, else the one set as its proxy. */
async function proxyOrigin(target: string): Promise<{ origin: string; remote: boolean }> {
  if (await selfHostedServer()) return { origin: appOrigin(), remote: false }
  if (proxyServer) return { origin: proxyServer, remote: true }
  throw new NoProxyServerError(target)
}

let selfHostedCheck: Promise<ServerInfo | null> | null = null
/**
 * The self-hosted server serving this page, asked once per page load; null on
 * the hosted app. A failed check (timeout, network) isn't kept, so the next
 * request asks again instead of treating a self-hosted server as hosted.
 */
export function selfHostedServer() {
  selfHostedCheck ??= fetchServerInfo(AbortSignal.timeout(5_000)).catch(() => {
    selfHostedCheck = null
    return null
  })
  return selfHostedCheck
}

/**
 * Whether this page may reach the user's machine (loopback) or local network,
 * from Chrome's Local Network Access (142+): "prompt" until the user answers
 * the browser's prompt, "unsupported" where the browser has none (Safari,
 * which blocks http://localhost from https pages outright).
 */
export type LocalAccessState = "granted" | "denied" | "prompt" | "unsupported"

let localAccessSupported: boolean | null = null

export async function localAccessState(space: "loopback" | "local" = "loopback"): Promise<LocalAccessState> {
  if (typeof navigator === "undefined" || !navigator.permissions) return "unsupported"
  try {
    // Never "local-network-access": the old name crashes older Chrome versions.
    const status = await navigator.permissions.query({ name: `${space}-network` as PermissionName })
    localAccessSupported = true
    return status.state
  } catch {
    localAccessSupported = false
    return "unsupported"
  }
}

/** Chrome's Local Network Access (Chrome 142+), as last seen by localAccessState (asked once at startup). */
export function supportsLocalNetworkAccess() {
  return localAccessSupported ?? (typeof Request !== "undefined" && "targetAddressSpace" in Request.prototype)
}

/**
 * Fetch options for a plain-http host on this machine or the local network
 * (a backend in direct mode, or the user's Cardinal server) from an https
 * page. Chrome requires the fetch to name the address space: that exempts it
 * from mixed-content blocking and asks the user once. Other browsers ignore it.
 */
function localNetworkInit(target: URL, init: RequestInit): RequestInit {
  if (globalThis.location?.protocol !== "https:" || target.protocol !== "http:") return init
  if (isLoopbackHost(target.hostname)) return { ...init, targetAddressSpace: "loopback" } as RequestInit
  if (isPrivateHost(target.hostname)) return { ...init, targetAddressSpace: "local" } as RequestInit
  return init
}
function isAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

/** Asks a Cardinal server whether this page may use it as its proxy: its info, or why not. */
export async function checkProxyServer(url: string, signal?: AbortSignal): Promise<ServerInfo> {
  const origin = proxyServerOrigin(url)
  if (!origin) throw new Error("Enter the server's address, like http://localhost:9181.")
  const target = new URL(SERVER_INFO_PATH, origin)
  let response: Response
  try {
    response = await fetch(target, localNetworkInit(target, { headers: { [CLIENT_HEADER]: "1" }, cache: "no-store", signal }))
  } catch (error) {
    if (isAbort(error)) throw error
    throw await proxyServerError(origin, error)
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null
  if (!isServerInfo(body)) throw new Error(`${origin} answered, but not as a Cardinal server.`)
  return body
}

/** The self-hosted server's info when it serves this page; null on the hosted app or in dev. Network errors throw. */
async function fetchServerInfo(signal?: AbortSignal): Promise<ServerInfo | null> {
  const response = await fetch(new URL(SERVER_INFO_PATH, appOrigin()), { headers: { [CLIENT_HEADER]: "1" }, cache: "no-store", signal })
  const body: unknown = response.ok ? await response.json().catch(() => null) : null
  return isServerInfo(body) ? body : null
}

/** Whether two base URLs name the same host and port; a skipped certificate check doesn't carry over to another backend. */
export function sameHost(a: string, b: string) {
  try {
    return new URL(normalizeBaseUrl(a)).host === new URL(normalizeBaseUrl(b)).host
  } catch {
    return false
  }
}

export async function send(connection: Connection, request: HttpRequest): Promise<Response> {
  const baseUrl = normalizeBaseUrl(connection.baseUrl)
  const proxy = connection.mode === "proxy" ? await proxyOrigin(baseUrl) : null
  const headers: Record<string, string> = { ...authHeaders(connection), ...request.headers }
  if (request.body !== undefined) headers["Content-Type"] = "application/json"

  let url: URL
  if (proxy) {
    url = new URL(`${PROXY_PREFIX}${request.path}`, proxy.origin)
    headers[PROXY_TARGET_HEADER] = baseUrl
    headers[CLIENT_HEADER] = "1"
    if (connection.tlsSkipVerify) headers[PROXY_SKIP_VERIFY_HEADER] = "1"
  } else {
    url = new URL(`${baseUrl}${request.path}`)
  }
  appendQuery(url, request.query)

  const attempt = async (refreshToken: boolean) => {
    if (proxy) headers[PROXY_TOKEN_HEADER] = await getProxyToken(proxy.origin, refreshToken)
    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      cache: "no-store",
      signal: request.signal,
    }
    // A backend, or the user's server, on the local network from an https page.
    return fetch(url, localNetworkInit(url, init))
  }

  let response: Response
  try {
    response = await attempt(false)
    // The proxy's own 401 (token expired, the client IP changed, or minted by another isolate): refresh, at most twice.
    for (let retry = 0; retry < 2 && response.status === 401 && response.headers.get(PROXY_ERROR_HEADER) === "token"; retry += 1) {
      await response.body?.cancel().catch(() => undefined)
      response = await attempt(true)
    }
  } catch (error) {
    if (isAbort(error)) throw error
    if (error instanceof ProxyTokenError) throw error
    if (!proxy) throw new CorsError(`${baseUrl}${request.path}`, error)
    if (proxy.remote) throw await proxyServerError(proxy.origin, error)
    throw new Error(`Network error: could not reach the Cardinal server (${String(error)})`, { cause: error })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const proxyFailure = proxy ? (response.headers.get(PROXY_ERROR_HEADER) as ProxyFailure | null) : null
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
