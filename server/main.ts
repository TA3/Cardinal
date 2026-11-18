import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { rootCertificates } from "node:tls"

import packageJson from "../package.json"
import { appUrl, banner, createLog, exitOnSignals, openBrowser } from "./cli"
import { ConfigError, DEFAULT_PORT, parseConfig, USAGE, type ServerConfig } from "./config"
import { createServerHandler } from "./server"
import type { Assets } from "./static"

// Entry point. `bun server/main.ts` serves ../dist/client from disk; the
// compiled binary (server/build.ts) calls start() with the embedded files.

function assetsFromDirectory(root: string): Assets {
  const assets = new Map<string, Blob>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) assets.set(`/${path.relative(root, full).split(path.sep).join("/")}`, Bun.file(full))
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root)
  return assets
}

async function healthcheck() {
  const port = Number(process.env.CARDINAL_PORT) || DEFAULT_PORT
  const scheme = process.env.CARDINAL_TLS_CERT ? "https" : "http"
  try {
    // Over HTTPS the certificate names localhost, not 127.0.0.1: only liveness matters here.
    const response = await fetch(`${scheme}://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000), tls: { rejectUnauthorized: false } })
    process.exit(response.ok ? 0 : 1)
  } catch {
    process.exit(1)
  }
}

/**
 * How the proxy reaches backends, for --proxy-via and --proxy-ca, and without
 * checking certificates for connections set to skip it. Bun's own fetch
 * already follows HTTPS_PROXY and NO_PROXY.
 */
function backendFetch(config: ServerConfig, ca: string | undefined, skipVerify = false): typeof fetch | undefined {
  if (!config.proxyVia && !ca && !skipVerify) return undefined
  // A CA of one's own replaces the built-in ones unless they come along: public backends would fail.
  const tls = skipVerify ? { rejectUnauthorized: false } : ca ? { ca: [...rootCertificates, ca] } : undefined
  const proxy = config.proxyVia
  return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, ...(tls ? { tls } : {}), ...(proxy ? { proxy } : {}) })) as typeof fetch
}

export interface StartOptions {
  /** The app's files, keyed by URL path. Undefined reads --static or ../dist/client. */
  assets?: Assets
  version?: string
}

export async function start(options: StartOptions = {}) {
  const argv = Bun.argv.slice(2)
  const version = options.version ?? packageJson.version
  if (argv[0] === "healthcheck") return healthcheck()
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  if (argv.includes("--version")) {
    console.log(version)
    return
  }

  let config
  try {
    config = parseConfig(argv, process.env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.error(`${error.message}\n\n${USAGE}`)
    process.exit(2)
  }

  const staticDir = config.staticDir ?? (options.assets ? undefined : path.resolve(import.meta.dir, "../dist/client"))
  const assets = staticDir ? assetsFromDirectory(staticDir) : options.assets!
  if (!assets.has("/index.html")) {
    console.warn(`No app build found${staticDir ? ` in ${staticDir}` : ""}; run \`bun run build\` first. The proxy still works.`)
  }

  let tls: { cert: string; key: string } | undefined
  let ca: string | undefined
  try {
    tls = config.tls && { cert: readFileSync(config.tls.cert, "utf8"), key: readFileSync(config.tls.key, "utf8") }
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

  const handle = createServerHandler({
    config,
    assets,
    version,
    fetch: backendFetch(config, ca),
    fetchSkippingVerify: backendFetch(config, ca, true),
    log: createLog(config),
  })
  let server
  try {
    server = Bun.serve({
      port: config.port,
      hostname: config.host,
      tls,
      // Longer than the proxy waits for a backend (--proxy-timeout); Bun allows at most 255 s.
      idleTimeout: Math.min(255, config.proxyTimeout + 30),
      fetch: (request, server) => handle(request, server.requestIP(request)?.address),
    })
  } catch (error) {
    const inUse = (error as { code?: string }).code === "EADDRINUSE"
    console.error(inUse ? `Port ${config.port} is in use. Start with --port <n>.` : error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const url = appUrl(config, server.port ?? config.port)
  console.log(banner(config, version, url, process.env))
  exitOnSignals(() => void server.stop(true))
  if (config.open) openBrowser(url)
  return server
}

if (import.meta.main) await start()
