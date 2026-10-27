import {
  CLIENT_HEADER,
  PROXY_ERROR_HEADER,
  PROXY_PREFIX,
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
// from the browser (needs CORS); proxy mode goes through the server that
// serves this page at /api/proxy (the Cardinal Worker, or a self-hosted
// `cardinal` server), which forwards credentials without storing them.

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
        ? detailMessage(detail) || `The Cardinal proxy failed (HTTP ${status})`
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

/**
 * Proxy mode on the hosted app was not allowed: the request would have carried
 * the backend's credentials and queries through Cardinal's Worker. A
 * self-hosted server's proxy needs no consent, since it is the user's own.
 */
export class ProxyConsentError extends Error {
  constructor(readonly target: string) {
    super(
      `Reaching ${hostLabel(target)} needs Cardinal's proxy, which passes your token and queries through Cardinal's servers. Allow it in Settings → Privacy, or run Cardinal on your own machine.`
    )
    this.name = "ProxyConsentError"
  }
}

function hostLabel(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

let proxyConsent = false
/** Set by the app store from the user's choice in Settings → Privacy. */
export function configureProxyConsent(allowed: boolean) {
  proxyConsent = allowed
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

/** Chrome's Local Network Access (Chrome 142+) adds `targetAddressSpace` to fetch. */
function supportsLocalNetworkAccess() {
  return typeof Request !== "undefined" && "targetAddressSpace" in Request.prototype
}

export { supportsLocalNetworkAccess }

/**
 * Fetch options for a plain-http host on the local network (a backend in
 * direct mode). An HTTPS page may call one only when the fetch says
 * so: Local Network Access exempts it from mixed-content blocking and asks the
 * user once. Loopback is always allowed.
 */
function localNetworkInit(target: URL, init: RequestInit): RequestInit {
  if (globalThis.location?.protocol !== "https:" || target.protocol !== "http:" || isLoopbackHost(target.hostname)) return init
  if (!isPrivateHost(target.hostname)) return init
  return { ...init, targetAddressSpace: "local" } as RequestInit
}
function isAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

/** The self-hosted server's info when it serves this page; null on the hosted app or in dev. Network errors throw. */
async function fetchServerInfo(signal?: AbortSignal): Promise<ServerInfo | null> {
  const response = await fetch(new URL(SERVER_INFO_PATH, appOrigin()), { headers: { [CLIENT_HEADER]: "1" }, cache: "no-store", signal })
  const body: unknown = response.ok ? await response.json().catch(() => null) : null
  return isServerInfo(body) ? body : null
}

export async function send(connection: Connection, request: HttpRequest): Promise<Response> {
  const baseUrl = normalizeBaseUrl(connection.baseUrl)
  if (connection.mode === "proxy" && !proxyConsent && !(await selfHostedServer())) throw new ProxyConsentError(baseUrl)
  const headers: Record<string, string> = { ...authHeaders(connection), ...request.headers }
  if (request.body !== undefined) headers["Content-Type"] = "application/json"

  let url: URL
  if (connection.mode === "proxy") {
    url = new URL(`${PROXY_PREFIX}${request.path}`, appOrigin())
    headers[PROXY_TARGET_HEADER] = baseUrl
    headers[CLIENT_HEADER] = "1"
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
    return fetch(url, connection.mode === "direct" ? localNetworkInit(url, init) : init)
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
