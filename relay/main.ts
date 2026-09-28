import { readdirSync, statSync } from "node:fs"
import path from "node:path"

import packageJson from "../package.json"
import { ConfigError, DEFAULT_PORT, parseConfig, USAGE } from "./config"
import { createRelayHandler } from "./server"
import type { Assets } from "./static"

// Entry point. `bun relay/main.ts` serves ../dist/client from disk; the
// compiled binary (relay/build.ts) calls start() with the embedded files.

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
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) })
    process.exit(response.ok ? 0 : 1)
  } catch {
    process.exit(1)
  }
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
    console.warn(`No app build found${staticDir ? ` in ${staticDir}` : ""}; run \`bun run build\` first. The relay still works.`)
  }

  const handle = createRelayHandler({ config, assets, version, log: (message) => console.warn(message) })
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // Upstream requests may take up to 30 s (lib/proxy/core).
    idleTimeout: 60,
    fetch: (request, server) => handle(request, server.requestIP(request)?.address),
  })

  const shown = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host.includes(":") ? `[${config.host}]` : config.host
  const lines = [
    `Cardinal ${version} on http://${shown}:${server.port}`,
    "",
    `Relay token:     ${config.relayToken}${config.tokenGenerated ? "  (new each start; set CARDINAL_RELAY_TOKEN to keep one)" : ""}`,
    `Relay origins:   ${config.origins.join(", ")}`,
    `Proxy targets:   ${config.allowHosts.length ? config.allowHosts.join(", ") : "any host, private and loopback included"}`,
  ]
  if (config.publicHosts.length) lines.push(`Public hosts:    ${config.publicHosts.join(", ")}`)
  console.log(lines.join("\n"))
  return server
}

if (import.meta.main) await start()
