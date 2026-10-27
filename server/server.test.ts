import { describe, expect, it, vi } from "vitest"

import { forwardProxyRequest, isHostAllowed } from "../lib/proxy/core"
import { ConfigError, parseConfig, type ServerConfig } from "./config"
import { AGENT_UNAVAILABLE, createServerHandler, isTrustedHost } from "./server"
import { serveStatic } from "./static"

const APP = "http://localhost:9181"
const SAME = { "Sec-Fetch-Site": "same-origin" }

function config(patch: Partial<ServerConfig> = {}): ServerConfig {
  return { port: 9181, host: "127.0.0.1", allowHosts: [], publicHosts: [], ...patch }
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
  const handle = createServerHandler({ config: config(patch), assets, version: "1.2.3", proxySecret: "secret", fetch: upstream as unknown as typeof fetch })
  return { handle, upstream }
}

const PROXY_PATH = "/api/proxy/api/v1/query?query=up"
const PRIVATE_TARGET = "http://127.0.0.1:9090"

/** A proxy token for `ip`, as the app gets one. */
async function proxyToken(handle: ReturnType<typeof setup>["handle"], ip = "10.0.0.5") {
  return ((await (await handle(new Request(`${APP}/api/proxy-token`, { headers: SAME }), ip)).json()) as { token: string }).token
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

describe("server config", () => {
  it("defaults to loopback and port 9181", () => {
    expect(parseConfig([], {})).toEqual({ port: 9181, host: "127.0.0.1", allowHosts: [], publicHosts: [], staticDir: undefined })
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
