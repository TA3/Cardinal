import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { serve } from "@hono/node-server"

import { ConfigError, DEFAULT_PORT, parseConfig, USAGE } from "./config"
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
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) })
    process.exit(response.ok ? 0 : 1)
  } catch {
    process.exit(1)
  }
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

  const assets = assetsFrom(config.staticDir ?? appDir)
  const handle = createServerHandler({ config, assets, version: CARDINAL_VERSION })
  const server = serve({
    port: config.port,
    hostname: config.host,
    fetch: (request, env: { incoming?: { socket?: { remoteAddress?: string } } }) => handle(request, env.incoming?.socket?.remoteAddress),
  })
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${config.port} is in use. Start with --port <n>.` : error.message)
    process.exit(1)
  })
  server.on("listening", () => {
    const shown = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host.includes(":") ? `[${config.host}]` : config.host
    const lines = [
      `Cardinal ${CARDINAL_VERSION} on http://${shown}:${config.port}`,
      "",
      `Proxy targets:   ${config.allowHosts.length ? config.allowHosts.join(", ") : "any host, private and loopback included"}`,
    ]
    if (config.publicHosts.length) lines.push(`Public hosts:    ${config.publicHosts.join(", ")}`)
    console.log(lines.join("\n"))
  })
}

await main()
