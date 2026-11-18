import { describe, expect, it, vi } from "vitest"

import { isHostAllowed } from "../lib/proxy/core"
import { ConfigError, parseConfig, type ServerConfig } from "./config"
import { AGENT_UNAVAILABLE, createServerHandler, isTrustedHost } from "./server"
import { serveStatic } from "./static"

const APP = "http://localhost:9181"
const SAME = { "Sec-Fetch-Site": "same-origin" }

function config(patch: Partial<ServerConfig> = {}): ServerConfig {
  return { ...parseConfig([], {}), ...patch }
}

const assets = new Map<string, Blob>([
  ["/index.html", new Blob(["<!doctype html><title>Cardinal</title>"])],
  ["/assets/index-abc123.js", new Blob(["console.log(1)"])],
  ["/assets/index-abc123.css", new Blob(["body{}"])],
  ["/favicon.svg", new Blob(["<svg/>"])],
  ["/_headers", new Blob(["/*"])],
])

function setup(patch: Partial<ServerConfig> = {}) {
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init
    return Response.json({ status: "success", data: { url: String(input) } })
  })
  const log = { warn: vi.fn<(message: string) => void>(), debug: vi.fn<(message: string) => void>() }
  const handle = createServerHandler({
    config: config(patch),
    assets,
    version: "1.2.3",
    proxySecret: "secret",
    fetch: upstream as unknown as typeof fetch,
    log: patch.debug ? log : { warn: log.warn },
  })
  return { handle, upstream, log }
}

const PROXY_PATH = "/api/proxy/api/v1/query?query=up"
const PRIVATE_TARGET = "http://127.0.0.1:9090"

/** A proxy token for `ip`, as the app gets one. */
async function proxyToken(handle: ReturnType<typeof setup>["handle"], ip = "10.0.0.5") {
  return ((await (await handle(new Request(`${APP}/api/proxy-token`, { headers: SAME }), ip)).json()) as { token: string }).token
}

describe("shared proxy core", () => {
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

describe("server config", () => {
  it("defaults to loopback and port 9181", () => {
    expect(parseConfig([], {})).toEqual({
      port: 9181,
      host: "127.0.0.1",
      allowHosts: [],
      publicHosts: [],
      allowOrigins: [],
      staticDir: undefined,
      proxyTimeout: 30,
      debug: false,
      open: false,
    })
  })

  it("takes switches with no value, or true and false", () => {
    expect(parseConfig(["--debug", "--open", "--port", "1"], {})).toMatchObject({ debug: true, open: true, port: 1 })
    expect(parseConfig(["--debug=false"], { CARDINAL_DEBUG: "1" }).debug).toBe(false)
    expect(parseConfig([], { CARDINAL_DEBUG: "true", CARDINAL_OPEN: "yes" })).toMatchObject({ debug: true, open: true })
    expect(() => parseConfig(["--debug=maybe"], {})).toThrow(ConfigError)
  })

  it("reads how the proxy reaches backends", () => {
    expect(parseConfig(["--proxy-timeout", "120", "--proxy-via", "http://user:pass@proxy.corp:3128/", "--proxy-ca", "corp.pem"], {})).toMatchObject({
      proxyTimeout: 120,
      proxyVia: "http://user:pass@proxy.corp:3128",
      proxyCa: "corp.pem",
    })
    // Skipping certificate checks is per connection, in the app.
    expect(() => parseConfig(["--proxy-insecure"], {})).toThrow(ConfigError)
    expect(parseConfig([], { CARDINAL_PROXY_VIA: "http://proxy:8080", CARDINAL_PROXY_TIMEOUT: "5" })).toMatchObject({ proxyVia: "http://proxy:8080", proxyTimeout: 5 })
    for (const bad of ["0", "241", "soon"]) expect(() => parseConfig(["--proxy-timeout", bad], {})).toThrow(ConfigError)
    for (const bad of ["proxy:3128", "socks5://proxy:1080"]) expect(() => parseConfig(["--proxy-via", bad], {})).toThrow(ConfigError)
  })

  it("reads the sites allowed to use the proxy, repeated or comma-separated, as origins", () => {
    expect(parseConfig(["--allow-origin", "https://cardinal.ta3.dev/", "--allow-origin=http://localhost:5173,https://cardinal.ta3.dev"], {}).allowOrigins).toEqual([
      "https://cardinal.ta3.dev",
      "http://localhost:5173",
    ])
    expect(parseConfig([], { CARDINAL_ALLOW_ORIGINS: "https://Cardinal.TA3.dev" }).allowOrigins).toEqual(["https://cardinal.ta3.dev"])
    for (const bad of ["cardinal.ta3.dev", "https://cardinal.ta3.dev/app", "ftp://x", "*"]) {
      expect(() => parseConfig(["--allow-origin", bad], {})).toThrow(ConfigError)
    }
  })

  it("serves HTTPS only with both a certificate and its key", () => {
    expect(parseConfig(["--tls-cert", "a.pem", "--tls-key", "a-key.pem"], {}).tls).toEqual({ cert: "a.pem", key: "a-key.pem" })
    expect(parseConfig([], { CARDINAL_TLS_CERT: "c.pem", CARDINAL_TLS_KEY: "k.pem" }).tls).toEqual({ cert: "c.pem", key: "k.pem" })
    expect(parseConfig([], {}).tls).toBeUndefined()
    expect(() => parseConfig(["--tls-cert", "a.pem"], {})).toThrow(ConfigError)
  })

  it("reads flags over environment variables", () => {
    const parsed = parseConfig(["--port", "8080", "--allow-hosts", "prom,loki:3100"], {
      CARDINAL_PORT: "1",
      CARDINAL_HOST: "0.0.0.0",
      CARDINAL_ALLOW_HOSTS: "ignored",
    })
    expect(parsed).toMatchObject({ port: 8080, host: "0.0.0.0", allowHosts: ["prom", "loki:3100"] })
  })

  it("rejects bad input, including the old relay flag", () => {
    expect(() => parseConfig(["--port", "99999"], {})).toThrow(ConfigError)
    expect(() => parseConfig(["--nope"], {})).toThrow(ConfigError)
    expect(() => parseConfig(["--origin", "https://cardinal.ta3.dev"], {})).toThrow(ConfigError)
  })
})

describe("server access", () => {
  it("describes itself to the app it serves", async () => {
    const { handle } = setup()
    const own = await handle(new Request(`${APP}/api/server/info`, { headers: SAME }))
    expect(await own.json()).toEqual({ kind: "cardinal-server", version: "1.2.3", agentSessions: false })
    expect(own.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("refuses other origins and non-browser clients, without CORS headers", async () => {
    const { handle, upstream } = setup()
    const cases: Array<Record<string, string>> = [
      { Origin: "https://cardinal.ta3.dev", "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "X-Cardinal-Client": "1" },
      {},
    ]
    for (const headers of cases) {
      for (const path of [PROXY_PATH, "/api/proxy-token", "/api/server/info"]) {
        for (const method of ["GET", "OPTIONS"]) {
          const response = await handle(new Request(`${APP}${path}`, { method, headers: { ...headers, "X-Cardinal-Target": PRIVATE_TARGET } }))
          expect(response.status).toBe(403)
          expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
        }
      }
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it("says once which flag would let a refused site or host name in", async () => {
    const { handle, log } = setup()
    for (let i = 0; i < 3; i++) {
      await handle(new Request(`${APP}/api/proxy-token`, { headers: { Origin: "https://cardinal.ta3.dev", "Sec-Fetch-Site": "cross-site" } }))
      await handle(new Request("http://cardinal.example.com/api/proxy-token", { headers: SAME }))
    }
    expect(log.warn.mock.calls.map(([message]) => message)).toEqual([
      "Turned away https://cardinal.ta3.dev. To let it use this server as its proxy, start it with --allow-origin https://cardinal.ta3.dev.",
      "Turned away requests for cardinal.example.com. If this server is reached by that name, start it with --public-hosts cardinal.example.com.",
    ])
    // Not a site trying to use the proxy: nothing to say.
    await handle(new Request(`${APP}/api/sessions`, { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } }))
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it("logs each API request with --debug: backend, status and why it failed, never the query or credentials", async () => {
    const { handle, log, upstream } = setup({ debug: true })
    const token = await proxyToken(handle)
    const headers = { ...SAME, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": "http://127.0.0.1:9090/prom/", Authorization: "Bearer secret-token" }
    await handle(new Request(`${APP}${PROXY_PATH}`, { headers }), "10.0.0.5")
    upstream.mockResolvedValueOnce(Response.json({ status: "error", error: "parse error at char 3" }, { status: 400 }))
    await handle(new Request(`${APP}${PROXY_PATH}`, { headers }), "10.0.0.5")
    await handle(new Request(`${APP}/api/proxy/api/v1/admin/tsdb/delete_series`, { method: "POST", headers }), "10.0.0.5")
    await vi.waitFor(() => expect(log.debug).toHaveBeenCalledTimes(4))
    const lines = log.debug.mock.calls.map(([message]) => message.replace(/ \d+ms/, " Nms"))
    expect(lines).toEqual([
      "GET /api/proxy-token 200 Nms",
      "GET http://127.0.0.1:9090/prom/api/v1/query 200 Nms",
      "GET http://127.0.0.1:9090/prom/api/v1/query 400 Nms: parse error at char 3",
      "POST http://127.0.0.1:9090/prom/api/v1/admin/tsdb/delete_series 403 Nms: [path] Path not allowed through the proxy: POST /api/v1/admin/tsdb/delete_series",
    ])
    expect(lines.join("\n")).not.toMatch(/secret-token|query=up/)
  })

  it("skips the certificate check only for https backends of connections that ask", async () => {
    const skipping = vi.fn(async () => Response.json({ status: "success", data: { skipped: true } }))
    const upstream = vi.fn(async () => Response.json({ status: "success", data: {} }))
    const log = { warn: vi.fn(), debug: vi.fn<(message: string) => void>() }
    const handle = createServerHandler({
      config: config({ debug: true }),
      assets,
      version: "1.2.3",
      proxySecret: "secret",
      fetch: upstream as unknown as typeof fetch,
      fetchSkippingVerify: skipping as unknown as typeof fetch,
      log,
    })
    const token = await proxyToken(handle)
    const call = (target: string, skip: boolean) =>
      handle(
        new Request(`${APP}${PROXY_PATH}`, {
          headers: { ...SAME, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": target, ...(skip ? { "X-Cardinal-Skip-TLS-Verify": "1" } : {}) },
        }),
        "10.0.0.5"
      )
    await call("https://prom.lan", true)
    expect(skipping).toHaveBeenCalledTimes(1)
    await call("https://prom.lan", false)
    await call("http://prom.lan", true)
    expect(skipping).toHaveBeenCalledTimes(1)
    expect(upstream).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(log.debug.mock.calls.some(([line]) => line.includes("https://prom.lan/api/v1/query (certificate not checked) 200"))).toBe(true))

    // A server built without one says so rather than checking quietly.
    const { handle: plain } = setup()
    const refused = await plain(
      new Request(`${APP}${PROXY_PATH}`, {
        headers: { ...SAME, "X-Cardinal-Proxy-Token": await proxyToken(plain), "X-Cardinal-Target": "https://prom.lan", "X-Cardinal-Skip-TLS-Verify": "1" },
      }),
      "10.0.0.5"
    )
    expect(refused.status).toBe(501)
    expect(refused.headers.get("X-Cardinal-Proxy-Error")).toBe("tls")
  })

  it("waits for a backend as long as --proxy-timeout says", async () => {
    const { handle, upstream } = setup({ proxyTimeout: 1 })
    upstream.mockImplementationOnce(
      (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    )
    const token = await proxyToken(handle)
    const started = Date.now()
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, { headers: { ...SAME, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": PRIVATE_TARGET } }),
      "10.0.0.5"
    )
    expect(response.status).toBe(504)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it("lets sites named with --allow-origin use the proxy, with CORS, and nothing else", async () => {
    const SITE = "https://cardinal.ta3.dev"
    const { handle, upstream } = setup({ allowOrigins: [SITE] })
    const cross = { Origin: SITE, "Sec-Fetch-Site": "cross-site" }

    const preflight = await handle(
      new Request(`${APP}${PROXY_PATH}`, {
        method: "OPTIONS",
        headers: { ...cross, "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" },
      })
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(SITE)
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("x-cardinal-proxy-token")
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("x-cardinal-skip-tls-verify")
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true")

    const info = await handle(new Request(`${APP}/api/server/info`, { headers: cross }))
    expect(info.headers.get("Access-Control-Allow-Origin")).toBe(SITE)
    expect(await info.json()).toMatchObject({ kind: "cardinal-server" })

    const { token } = (await (await handle(new Request(`${APP}/api/proxy-token`, { headers: cross }), "127.0.0.1")).json()) as { token: string }
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, { headers: { ...cross, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": PRIVATE_TARGET } }),
      "127.0.0.1"
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE)
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Cardinal-Proxy-Error")
    expect(upstream).toHaveBeenCalledTimes(1)

    // The proxy's own errors stay readable to the site.
    const missing = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...cross, "X-Cardinal-Target": PRIVATE_TARGET } }), "127.0.0.1")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBe(SITE)

    // Other sites, and other endpoints for the allowed one, are refused as before.
    const other = await handle(new Request(`${APP}/api/proxy-token`, { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } }))
    expect(other.status).toBe(403)
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull()
    const sessions = await handle(new Request(`${APP}/api/sessions`, { method: "POST", headers: cross }))
    expect(sessions.status).toBe(403)
    // Still only under trusted host names (DNS rebinding).
    const rebound = await handle(new Request("http://attacker.example:9181/api/proxy-token", { headers: cross }))
    expect(rebound.status).toBe(403)
  })

  it("serves its own app like the Worker: a proxy token, then private hosts too", async () => {
    const { handle, upstream } = setup()
    const missing = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...SAME, "X-Cardinal-Target": PRIVATE_TARGET } }), "10.0.0.5")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("X-Cardinal-Proxy-Error")).toBe("token")

    const token = await proxyToken(handle)
    const response = await handle(
      new Request(`${APP}${PROXY_PATH}`, {
        headers: { ...SAME, "X-Cardinal-Proxy-Token": token, "X-Cardinal-Target": `${PRIVATE_TARGET}/prom/`, Authorization: "Bearer abc" },
      }),
      "10.0.0.5"
    )
    expect(response.status).toBe(200)
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe("http://127.0.0.1:9090/prom/api/v1/query?query=up")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer abc")
  })

  it("keeps the path allowlist and the host allowlist", async () => {
    const { handle, upstream } = setup({ allowHosts: ["prometheus.lan"] })
    const token = await proxyToken(handle)
    const headers = { ...SAME, "X-Cardinal-Proxy-Token": token }
    const path = await handle(
      new Request(`${APP}/api/proxy/api/v1/admin/tsdb/delete_series`, { headers: { ...headers, "X-Cardinal-Target": "http://prometheus.lan" } }),
      "10.0.0.5"
    )
    expect(path.status).toBe(403)
    expect(path.headers.get("X-Cardinal-Proxy-Error")).toBe("path")
    const host = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...headers, "X-Cardinal-Target": PRIVATE_TARGET } }), "10.0.0.5")
    expect(host.status).toBe(403)
    expect(host.headers.get("X-Cardinal-Proxy-Error")).toBe("host")
    const ok = await handle(new Request(`${APP}${PROXY_PATH}`, { headers: { ...headers, "X-Cardinal-Target": "http://prometheus.lan" } }), "10.0.0.5")
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
    const rebound = await handle(new Request("http://attacker.example:9181/api/proxy-token", { headers: SAME }))
    expect(rebound.status).toBe(403)
    expect(rebound.headers.get("X-Cardinal-Proxy-Error")).toBe("public-host")
    const listed = setup({ publicHosts: ["attacker.example"] }).handle
    expect((await listed(new Request("http://attacker.example:9181/api/proxy-token", { headers: SAME }))).status).toBe(200)
  })

  it("answers agent endpoints with 501", async () => {
    const { handle } = setup()
    for (const [method, path] of [
      ["POST", "/api/sessions"],
      ["GET", "/api/sessions/abc"],
      ["POST", "/mcp"],
      ["POST", "/mcp/token"],
    ]) {
      const response = await handle(new Request(`${APP}${path}`, { method, headers: SAME }))
      expect(response.status).toBe(501)
      expect((await response.json()).error).toBe(AGENT_UNAVAILABLE)
    }
  })
})

describe("server static files", () => {
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
