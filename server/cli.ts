import { spawn } from "node:child_process"

import { DEFAULT_PROXY_TIMEOUT, type ServerConfig } from "./config"
import type { ServerLog } from "./server"

// What both entry points (main.ts on Bun, node.ts on Node) print and do
// around the server: the startup lines, logging, opening the browser and
// stopping.

function time() {
  return new Date().toTimeString().slice(0, 8)
}

/** Warnings always, a line per API request with --debug. */
export function createLog(config: ServerConfig): ServerLog {
  return {
    warn: (message) => console.warn(`${time()} ${message}`),
    ...(config.debug ? { debug: (message: string) => console.log(`${time()} ${message}`) } : {}),
  }
}

/** The address to open: localhost for loopback and any-address binds, the name certificates carry. */
export function appUrl(config: ServerConfig, port: number) {
  const local = ["127.0.0.1", "::1", "0.0.0.0", "::", "localhost"].includes(config.host)
  const host = local ? "localhost" : config.host.includes(":") ? `[${config.host}]` : config.host
  return `${config.tls ? "https" : "http"}://${host}:${port}`
}

/** The HTTP proxy the environment names for backends, as curl reads it. */
export function environmentProxy(env: Record<string, string | undefined>) {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined
}

/** Hides the password in http://user:password@proxy:3128. */
function withoutPassword(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = "***"
    return parsed.href.replace(/\/$/, "")
  } catch {
    return url
  }
}

/** What the server is and how it is set up, printed once it listens. */
export function banner(config: ServerConfig, version: string, url: string, env: Record<string, string | undefined>) {
  const lines = [`Cardinal ${version} on ${url}`, ""]
  const row = (label: string, value: string) => lines.push(`${`${label}:`.padEnd(16)} ${value}`)
  row("Proxy targets", config.allowHosts.length ? config.allowHosts.join(", ") : "any host, private and loopback included")
  if (config.publicHosts.length) row("Public hosts", config.publicHosts.join(", "))
  if (config.allowOrigins.length) row("Proxy for", config.allowOrigins.join(", "))
  const fromEnvironment = environmentProxy(env)
  if (config.proxyVia) row("Backends via", withoutPassword(config.proxyVia))
  else if (fromEnvironment) {
    row("Backends via", `${withoutPassword(fromEnvironment)} (from the environment${env.NO_PROXY || env.no_proxy ? ", except NO_PROXY" : ""})`)
  }
  if (config.proxyCa) row("Backend TLS", `also trusts ${config.proxyCa}`)
  if (config.proxyTimeout !== DEFAULT_PROXY_TIMEOUT) row("Proxy timeout", `${config.proxyTimeout} s`)
  row("Logging", config.debug ? "every API request (--debug)" : "problems only; --debug logs every request")
  if (config.allowOrigins.length) {
    lines.push("", `On ${config.allowOrigins.join(" or ")}, set ${url} under Settings > Your Cardinal server.`)
    if (!config.tls && config.allowOrigins.some((origin) => origin.startsWith("https:"))) {
      lines.push("Safari blocks https sites from reaching http://localhost: for Safari, serve HTTPS with --tls-cert and --tls-key.")
    }
  }
  return lines.join("\n")
}

/** Opens `url` in the default browser, for --open. */
export function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => console.warn(`Couldn't open a browser: open ${url} yourself.`))
  child.unref()
}

/** Ctrl-C and `docker stop`. As PID 1 in a container, nothing else ends the process on SIGTERM. */
export function exitOnSignals(close: () => void) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      close()
      process.exit(0)
    })
  }
}
