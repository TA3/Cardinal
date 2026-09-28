import { describe, expect, it, vi } from "vitest"

import { forwardProxyRequest, isHostAllowed } from "../lib/proxy/core"
import { ConfigError, parseConfig, type RelayConfig } from "./config"
import { AGENT_UNAVAILABLE, createRelayHandler, isTrustedHost, tokensMatch } from "./server"
import { serveStatic } from "./static"

const TOKEN = "relay-token-0123456789abcdef"
const APP = "http://localhost:9181"
const HOSTED = "https://cardinal.ta3.dev"

function config(patch: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 9181,
    host: "127.0.0.1",
    allowHosts: [],
    origins: [HOSTED, "http://localhost:5173"],
    publicHosts: [],
    relayToken: TOKEN,
    tokenGenerated: false,
    ...patch,
  }
}

const assets = new Map<string, Blob>([
  ["/index.html", new Blob(["<!doctype html><title>Cardinal</title>"])],
  ["/assets/index-abc123.js", new Blob(["console.log(1)"])],
  ["/assets/index-abc123.css", new Blob(["body{}"])],
  ["/favicon.svg", new Blob(["<svg/>"])],
  ["/_headers", new Blob(["/*"])],
])

function setup(patch: Partial<RelayConfig> = {}) {
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init
    return Response.json({ status: "success", data: { url: String(input) } })
  })
  const handle = createRelayHandler({ config: config(patch), assets, version: "1.2.3", proxySecret: "secret", fetch: upstream as unknown as typeof fetch })
  return { handle, upstream }
}

const PROXY_PATH = "/api/proxy/api/v1/query?query=up"
const PRIVATE_TARGET = "http://127.0.0.1:9090"

function crossOrigin(origin: string, headers: Record<string, string> = {}) {
  return { Origin: origin, "Sec-Fetch-Site": "cross-site", ...headers }
}

describe("shared proxy core", () => {
  const request = (target: string) => new Request(`https://x${PROXY_PATH}`, { headers: { "X-Cardinal-Target": target } })
  const ok = vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch

  it("refuses private targets only when asked to (the Worker)", async () => {
    const blocked = await forwardProxyRequest(request(PRIVATE_TARGET), { blockPrivate: true, fetch: ok })
    expect(blocked.status).toBe(400)
    expect(blocked.headers.get("X-Cardinal-Proxy-Error")).toBe("private")
    const allowed = await forwardProxyRequest(request(PRIVATE_TARGET), { blockPrivate: false, fetch: ok })
    expect(allowed.status).toBe(200)
  })

  it("matches host allowlists by host, port and wildcard", () => {
    const url = (value: string) => new URL(value)
    expect(isHostAllowed(url("http://prom:9090"), [])).toBe(true)
    expect(isHostAllowed(url("http://prom:9090"), ["prom"])).toBe(true)
    expect(isHostAllowed(url("http://prom:9090"), ["prom:9090"])).toBe(true)
    expect(isHostAllowed(url("http://prom:9091"), ["prom:9090"])).toBe(false)
    expect(isHostAllowed(url("https://a.corp.example/"), ["*.corp.example"])).toBe(true)
    expect(isHostAllowed(url("https://corp.example.evil.com/"), ["*.corp.example"])).toBe(false)
    expect(isHostAllowed(url("http://[::1]:9090"), ["[::1]"])).toBe(true)
    expect(isHostAllowed(url("http://10.0.0.1"), ["10.0.0.2"])).toBe(false)
  })
})

describe("relay config", () => {
  it("defaults to loopback, port 9181 and the hosted origin with a random token", () => {
    const parsed = parseConfig([], {})
    expect(parsed).toMatchObject({ port: 9181, host: "127.0.0.1", allowHosts: [], origins: [HOSTED], tokenGenerated: true })
    expect(parsed.relayToken).toMatch(/^[0-9a-f]{48}$/)
    expect(parseConfig([], {}).relayToken).not.toBe(parsed.relayToken)
  })

  it("reads flags over environment variables", () => {
    const parsed = parseConfig(["--port", "8080", "--origin=http://localhost:5173/", "--allow-hosts", "prom,loki:3100"], {
      CARDINAL_PORT: "1",
      CARDINAL_HOST: "0.0.0.0",
      CARDINAL_ORIGINS: "https://grafana.example",
      CARDINAL_RELAY_TOKEN: TOKEN,
      CARDINAL_ALLOW_HOSTS: "ignored",
    })
    expect(parsed).toMatchObject({
      port: 8080,
      host: "0.0.0.0",
      allowHosts: ["prom", "loki:3100"],
      origins: [HOSTED, "https://grafana.example", "http://localhost:5173"],
      relayToken: TOKEN,
      tokenGenerated: false,
    })
  })

  it("rejects bad input", () => {
    expect(() => parseConfig(["--port", "99999"], {})).toThrow(ConfigError)
    expect(() => parseConfig(["--nope"], {})).toThrow(ConfigError)
    expect(() => parseConfig(["--origin", "ftp://x"], {})).toThrow(ConfigError)
    expect(() => parseConfig([], { CARDINAL_RELAY_TOKEN: "short" })).toThrow(/16 characters/)
  })
})

describe("relay access", () => {
  it("compares tokens by digest", async () => {
    expect(await tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(await tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(await tokensMatch("", TOKEN)).toBe(false)
    expect(await tokensMatch("", "")).toBe(false)
  })

  it("describes itself to the app on its own origin and to allowed origins with the token", async () => {
    const { handle } = setup()
    const own = await handle(new Request(`${APP}/api/relay/info`, { headers: { "Sec-Fetch-Site": "same-origin" } }))
    expect(await own.json()).toEqual({ kind: "cardinal-server", version: "1.2.3", agentSessions: false, mode: "self-hosted" })
    expect(own.headers.get("Access-Control-Allow-Origin")).toBeNull()

    const relay = await handle(new Request(`${APP}/api/relay/info`, { headers: crossOrigin(HOSTED, { "X-Cardinal-Relay-Token": TOKEN }) }))
    expect(relay.status).toBe(200)
    expect(relay.headers.get("Access-Control-Allow-Origin")).toBe(HOSTED)
    expect((await relay.json()).mode).toBe("relay")
  })

  it("answers allowed preflights with CORS and Private Network Access headers", async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, {
        method: "OPTIONS",
        headers: {
          Origin: HOSTED,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization,x-cardinal-target,x-cardinal-relay-token",
          "Access-Control-Request-Private-Network": "true",
        },
      })
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(HOSTED)
    expect(response.headers.get("Access-Control-Allow-Private-Network")).toBe("true")
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("x-cardinal-relay-token")
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull()
    expect(response.headers.get("Vary")).toBe("Origin")
  })

  it("gives other origins no CORS headers, even with the token", async () => {
    const log = vi.fn()
    const handle = createRelayHandler({ config: config(), assets, version: "1", log })
    for (const method of ["OPTIONS", "GET"]) {
      const response = await handle(
        new Request(`${APP}${PROXY_PATH}`, { method, headers: crossOrigin("https://evil.example", { "X-Cardinal-Relay-Token": TOKEN, "X-Cardinal-Target": PRIVATE_TARGET }) })
      )
      expect(response.status).toBe(403)
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain("--origin https://evil.example")
  })

  it("requires the relay token from allowed origins and non-browser clients", async () => {
    const { handle, upstream } = setup()
    const cases: Record<string, string>[] = [
      crossOrigin(HOSTED),
      crossOrigin(HOSTED, { "X-Cardinal-Relay-Token": "wrong" }),
      {},
      { "X-Cardinal-Relay-Token": "wrong" },
    ]
    for (const headers of cases) {
      const response = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...headers, "X-Cardinal-Target": PRIVATE_TARGET } }))
      expect(response.status).toBe(401)
      expect(response.headers.get("X-Cardinal-Proxy-Error")).toBe("relay-token")
    }
    // Allowed origins can read the 401, so the app can say the token is wrong.
    const denied = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...crossOrigin(HOSTED), "X-Cardinal-Target": PRIVATE_TARGET } }))
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(HOSTED)
    expect(denied.headers.get("Access-Control-Expose-Headers")).toContain("X-Cardinal-Proxy-Error")
    // An allowed origin can't borrow the same-origin path: it has no proxy token and Origin gives it away.
    const borrowed = await handle(new Request(`${APP}/api/proxy-token`, { headers: { Origin: HOSTED, "X-Cardinal-Client": "1" } }))
    expect(borrowed.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("relays to private hosts with the token, forwarding credentials but not the relay token", async () => {
    const { handle, upstream } = setup()
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, {
        headers: crossOrigin(HOSTED, { "X-Cardinal-Relay-Token": TOKEN, "X-Cardinal-Target": `${PRIVATE_TARGET}/prom/`, Authorization: "Bearer abc" }),
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(HOSTED)
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe("http://127.0.0.1:9090/prom/api/v1/query?query=up")
    const sent = new Headers(init?.headers)
    expect(sent.get("authorization")).toBe("Bearer abc")
    expect(sent.get("x-cardinal-relay-token")).toBeNull()
  })

  it("serves its own app like the Worker: a proxy token, then private hosts too", async () => {
    const { handle, upstream } = setup()
    const same = { "Sec-Fetch-Site": "same-origin" }
    const missing = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...same, "X-Cardinal-Target": PRIVATE_TARGET } }), "10.0.0.5")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("X-Cardinal-Proxy-Error")).toBe("token")

    const { token } = await (await handle(new Request(`${APP}/api/proxy-token`, { headers: same }), "10.0.0.5")).json()
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, { headers: { ...same, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": PRIVATE_TARGET } }),
      "10.0.0.5"
    )
    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it("keeps the path allowlist and the host allowlist", async () => {
    const { handle, upstream } = setup({ allowHosts: ["prometheus.lan"] })
    const headers = crossOrigin(HOSTED, { "X-Cardinal-Relay-Token": TOKEN })
    const path = await handle(new Request(`${APP}/api/proxy/api/v1/admin/tsdb/delete_series`, { headers: { ...headers, "X-Cardinal-Target": "http://prometheus.lan" } }))
    expect(path.status).toBe(403)
    expect(path.headers.get("X-Cardinal-Proxy-Error")).toBe("path")
    const host = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...headers, "X-Cardinal-Target": PRIVATE_TARGET } }))
    expect(host.status).toBe(403)
    expect(host.headers.get("X-Cardinal-Proxy-Error")).toBe("host")
    const ok = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...headers, "X-Cardinal-Target": "http://prometheus.lan" } }))
    expect(ok.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it("refuses same-origin proxy use under public host names it wasn't told about (DNS rebinding)", async () => {
    expect(isTrustedHost("localhost", [])).toBe(true)
    expect(isTrustedHost("192.168.1.20", [])).toBe(true)
    expect(isTrustedHost("[::1]", [])).toBe(true)
    expect(isTrustedHost("nas", [])).toBe(true)
    expect(isTrustedHost("cardinal.home.arpa", [])).toBe(true)
    expect(isTrustedHost("attacker.example", [])).toBe(false)
    expect(isTrustedHost("cardinal.corp.example", ["cardinal.corp.example"])).toBe(true)

    const { handle } = setup()
    const rebound = await handle(new Request("http://attacker.example:9181/api/proxy-token", { headers: { "Sec-Fetch-Site": "same-origin" } }))
    expect(rebound.status).toBe(403)
    expect(rebound.headers.get("X-Cardinal-Proxy-Error")).toBe("public-host")
    const listed = setup({ publicHosts: ["attacker.example"] }).handle
    expect((await listed(new Request("http://attacker.example:9181/api/proxy-token", { headers: { "Sec-Fetch-Site": "same-origin" } }))).status).toBe(200)
  })

  it("answers agent endpoints with 501", async () => {
    const { handle } = setup()
    for (const [method, path] of [
      ["POST", "/api/sessions"],
      ["GET", "/api/sessions/abc"],
      ["POST", "/mcp"],
      ["POST", "/mcp/token"],
    ]) {
      const response = await handle(new Request(`${APP}${path}`, { method, headers: { "Sec-Fetch-Site": "same-origin" } }))
      expect(response.status).toBe(501)
      expect((await response.json()).error).toBe(AGENT_UNAVAILABLE)
    }
  })
})

describe("relay static files", () => {
  const get = (path: string, method = "GET") => serveStatic(new Request(`${APP}${path}`, { method }), assets)

  it("serves files with their content type and caches hashed assets", async () => {
    const js = get("/assets/index-abc123.js")
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8")
    expect(js.headers.get("Cache-Control")).toContain("immutable")
    expect(await js.text()).toBe("console.log(1)")
    expect(get("/assets/index-abc123.css").headers.get("Content-Type")).toBe("text/css; charset=utf-8")
    expect(get("/favicon.svg").headers.get("Content-Type")).toBe("image/svg+xml")
    expect(get("/favicon.svg").headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("falls back to index.html for app routes, not for missing files", async () => {
    for (const path of ["/", "/metrics", "/metrics/jobs/a%2Fb", "/settings"]) {
      const response = get(path)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
      expect(response.headers.get("Cache-Control")).toBe("no-cache")
    }
    expect(get("/assets/missing.js").status).toBe(404)
    expect(get("/_headers").status).toBe(404)
    expect(get("/", "POST").status).toBe(405)
    const head = get("/metrics", "HEAD")
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
  })

  it("serves the app through the handler but keeps unknown API paths 404", async () => {
    const { handle } = setup()
    expect((await handle(new Request(`${APP}/rules`))).headers.get("Content-Type")).toContain("text/html")
    expect((await handle(new Request(`${APP}/api/nope`, { headers: { "Sec-Fetch-Site": "same-origin" } }))).status).toBe(404)
    expect(await (await handle(new Request(`${APP}/healthz`))).text()).toBe("ok")
  })
})

// The app side of Relay mode. lib/sources needs DOM types this project's tests
// don't list, so the module is loaded at runtime with local types (as in lib/sources/sources.test.ts).
interface TransportModule {
  configureRelay(target: { url: string; token: string } | null): void
  send(connection: { baseUrl: string; mode: "relay" }, request: { path: string; query?: Record<string, string> }): Promise<Response>
  fetchRelayInfo(target: { url: string; token: string }): Promise<{ kind: string; latencyMs: number }>
}
const transportPath = "@/lib/sources/transport"
const loadTransport = async () => (await import(/* @vite-ignore */ transportPath)) as TransportModule

describe("relay mode in the app", () => {
  const connection = { baseUrl: "http://127.0.0.1:9090/", mode: "relay" as const }

  async function withFetch<T>(impl: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<T>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return impl(String(input), init)
    })
    try {
      return { result: await run().catch((error: unknown) => error), calls }
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it("sends requests to the relay's /api/proxy with the target and relay token", async () => {
    const { configureRelay, send } = await loadTransport()
    configureRelay({ url: "http://localhost:9181/", token: ` ${TOKEN} ` })
    const { calls } = await withFetch(
      () => Response.json({ status: "success" }),
      () => send(connection, { path: "/api/v1/query", query: { query: "up" } })
    )
    expect(calls[0].url).toBe("http://localhost:9181/api/proxy/api/v1/query?query=up")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers["X-Cardinal-Target"]).toBe("http://127.0.0.1:9090")
    expect(headers["X-Cardinal-Relay-Token"]).toBe(TOKEN)
    expect(headers["X-Cardinal-Proxy-Token"]).toBeUndefined()
  })

  it("explains a wrong token, an origin the relay refuses and a relay that isn't there", async () => {
    const { configureRelay, send } = await loadTransport()
    configureRelay({ url: "http://localhost:9181", token: "wrong" })
    const denied = await withFetch(
      () => Response.json({ error: "Missing or wrong relay token" }, { status: 401, headers: { "X-Cardinal-Proxy-Error": "relay-token" } }),
      () => send(connection, { path: "/api/v1/query" })
    )
    expect(denied.result).toMatchObject({ name: "HttpError", proxyFailure: "relay-token" })
    expect(String((denied.result as Error).message)).toMatch(/token/)

    // CORS failure, but a no-cors probe gets an answer: the relay refused this origin.
    const origin = await withFetch(
      (_url, init) => (init.mode === "no-cors" ? new Response(null) : Promise.reject(new TypeError("Failed to fetch"))),
      () => send(connection, { path: "/api/v1/query" })
    )
    expect(origin.result).toMatchObject({ name: "RelayError", kind: "origin" })
    expect(origin.calls[1].url).toBe("http://localhost:9181/healthz")

    const down = await withFetch(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => send(connection, { path: "/api/v1/query" })
    )
    expect(down.result).toMatchObject({ name: "RelayError", kind: "unreachable" })

    configureRelay(null)
    const unset = await withFetch(
      () => Response.json({}),
      () => send(connection, { path: "/api/v1/query" })
    )
    expect(unset.result).toMatchObject({ name: "RelayError", kind: "not-configured" })
    expect(unset.calls).toHaveLength(0)
  })

  it("tests a relay through /api/relay/info", async () => {
    const { fetchRelayInfo } = await loadTransport()
    const ok = await withFetch(
      () => Response.json({ kind: "cardinal-server", version: "1", agentSessions: false, mode: "relay" }),
      () => fetchRelayInfo({ url: "http://localhost:9181", token: TOKEN })
    )
    expect(ok.result).toMatchObject({ kind: "cardinal-server" })
    expect(ok.calls[0].url).toBe("http://localhost:9181/api/relay/info")
    const bad = await withFetch(
      () => Response.json({ error: "no" }, { status: 401 }),
      () => fetchRelayInfo({ url: "http://localhost:9181", token: "x" })
    )
    expect(bad.result).toMatchObject({ name: "RelayError", kind: "token" })
    const other = await withFetch(
      () => new Response("<html>"),
      () => fetchRelayInfo({ url: "http://localhost:9181", token: "x" })
    )
    expect(other.result).toMatchObject({ name: "RelayError", kind: "not-cardinal" })
  })
})
