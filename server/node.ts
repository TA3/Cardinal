import { spawn } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createServer as createHttpsServer, get as httpsGet, request as httpsRequest } from "node:https"
import path from "node:path"
import { Readable } from "node:stream"
import * as nodeTls from "node:tls"
import { fileURLToPath } from "node:url"

import { serve } from "@hono/node-server"

import { appUrl, banner, createLog, environmentProxy, exitOnSignals, openBrowser } from "./cli"
import { ConfigError, DEFAULT_PORT, parseConfig, USAGE, type ServerConfig } from "./config"
import { createServerHandler } from "./server"
import { SKIPPED_ASSETS, type Assets } from "./static"

// Entry point of the npm package (`npx @ta3/cardinal`): the same server as
// main.ts, on Node instead of Bun. server/npm.ts bundles it next to the
// built app in ./app.

declare const CARDINAL_VERSION: string

const appDir = fileURLToPath(new URL("./app", import.meta.url))

function assetsFrom(root: string): Assets {
  const assets = new Map<string, Blob>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const url = `/${path.relative(root, full).split(path.sep).join("/")}`
        if (!SKIPPED_ASSETS.has(url)) assets.set(url, new Blob([readFileSync(full)]))
      }
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root)
  return assets
}

async function healthcheck() {
  const port = Number(process.env.CARDINAL_PORT) || DEFAULT_PORT
  if (process.env.CARDINAL_TLS_CERT) {
    // The certificate names localhost, not 127.0.0.1: only liveness matters here.
    const request = httpsGet({ host: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false, timeout: 3_000 }, (response) =>
      process.exit(response.statusCode === 200 ? 0 : 1)
    )
    request.on("error", () => process.exit(1))
    request.on("timeout", () => process.exit(1))
    return
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) })
    process.exit(response.ok ? 0 : 1)
  } catch {
    process.exit(1)
  }
}

/**
 * Node's fetch follows HTTPS_PROXY and NO_PROXY only when started with
 * --use-env-proxy, so for --proxy-via (or a proxy in the environment) this
 * runs Cardinal again with it, as a child that shares the terminal. Returns
 * whether it did.
 */
function relaunchForProxy(config: ServerConfig) {
  const proxy = config.proxyVia ?? environmentProxy(process.env)
  if (!proxy || process.execArgv.includes("--use-env-proxy")) return false
  if (process.env.NODE_USE_ENV_PROXY === "1" && !config.proxyVia) return false
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    const why = `Node ${process.version} can't reach backends through an HTTP proxy. Update Node, or use the cardinal binary or Docker image.`
    if (config.proxyVia) {
      console.error(why)
      process.exit(2)
    }
    console.warn(`${why} Backends are reached directly.`)
    return false
  }
  const env = { ...process.env }
  if (config.proxyVia) {
    // Every backend through it, as --proxy-via says.
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = config.proxyVia
    delete env.NO_PROXY
    delete env.no_proxy
  }
  const child = spawn(process.execPath, ["--use-env-proxy", ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  return true
}

/** --proxy-ca, for every TLS connection the proxy makes to a backend. */
function backendTls(config: ServerConfig, ca: string | undefined) {
  if (!ca) return
  const tls = nodeTls as typeof nodeTls & { setDefaultCACertificates?: (certs: string[]) => void }
  if (typeof tls.setDefaultCACertificates !== "function") {
    console.error(`Node ${process.version} can't add a CA once started: set NODE_EXTRA_CA_CERTS=${config.proxyCa} instead, or update Node.`)
    process.exit(2)
  }
  // Added to the ones Node trusts already, so public backends still work.
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ca])
}

/**
 * fetch for a backend whose certificate isn't checked (a connection set to
 * skip it). Node's fetch has no per-request option for that, so this goes
 * through node:https, which follows --use-env-proxy too. It never redirects,
 * like the proxy's fetch.
 */
function fetchSkippingVerify(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = init.method ?? "GET"
  const body = init.body ? Buffer.from(init.body as ArrayBuffer) : undefined
  return new Promise((resolve, reject) => {
    const options = { method, headers: Object.fromEntries(new Headers(init.headers)), rejectUnauthorized: false, signal: init.signal ?? undefined }
    const request = httpsRequest(url, options, (response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        for (const one of value === undefined ? [] : Array.isArray(value) ? value : [value]) headers.append(name, one)
      }
      const status = response.statusCode ?? 502
      const empty = status === 204 || status === 304 || method === "HEAD"
      if (empty) response.resume()
      resolve(new Response(empty ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>), { status, headers }))
    })
    request.on("error", reject)
    request.end(body)
  })
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === "healthcheck") return healthcheck()
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE)
  if (argv.includes("--version")) return console.log(CARDINAL_VERSION)

  let config
  try {
    config = parseConfig(argv, process.env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.error(`${error.message}\n\n${USAGE}`)
    process.exit(2)
  }

  if (relaunchForProxy(config)) return

  let tls: { cert: Buffer; key: Buffer } | undefined
  let ca: string | undefined
  try {
    tls = config.tls && { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }
  } catch (error) {
    console.error(`Can't read the TLS certificate or key: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  try {
    ca = config.proxyCa ? readFileSync(config.proxyCa, "utf8") : undefined
  } catch (error) {
    console.error(`Can't read the CA for backends (--proxy-ca): ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  backendTls(config, ca)

  const assets = assetsFrom(config.staticDir ?? appDir)
  const handle = createServerHandler({ config, assets, version: CARDINAL_VERSION, fetchSkippingVerify: fetchSkippingVerify as typeof fetch, log: createLog(config) })
  const server = serve({
    port: config.port,
    hostname: config.host,
    ...(tls ? { createServer: createHttpsServer, serverOptions: tls } : {}),
    fetch: (request, env: { incoming?: { socket?: { remoteAddress?: string } } }) => handle(request, env.incoming?.socket?.remoteAddress),
  })
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${config.port} is in use. Start with --port <n>.` : error.message)
    process.exit(1)
  })
  server.on("listening", () => {
    const address = server.address()
    const url = appUrl(config, typeof address === "object" && address ? address.port : config.port)
    console.log(banner(config, CARDINAL_VERSION, url, process.env))
    if (config.open) openBrowser(url)
  })
  exitOnSignals(() => server.close())
}

await main()
