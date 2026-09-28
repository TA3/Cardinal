import { HOSTED_ORIGIN } from "../lib/sources/proxy-constants"

export const DEFAULT_PORT = 9181

export interface RelayConfig {
  port: number
  host: string
  /** Proxy targets allowed (lib/proxy/core isHostAllowed); empty allows all, private hosts included. */
  allowHosts: string[]
  /** Origins allowed to use this server as a relay (CORS plus the relay token). */
  origins: string[]
  /** Host names this server is reached by, besides localhost and IP addresses (DNS rebinding guard). */
  publicHosts: string[]
  relayToken: string
  /** True when the token was generated at startup rather than set with CARDINAL_RELAY_TOKEN. */
  tokenGenerated: boolean
  /** Serve the app from this directory instead of the embedded copy. */
  staticDir?: string
}

export const USAGE = `cardinal: self-hosted Cardinal and relay for private Prometheus, Loki and Grafana

Usage: cardinal [options]
       cardinal healthcheck

Options (environment variable in brackets):
  --port <n>            Port to listen on, default ${DEFAULT_PORT} [CARDINAL_PORT]
  --host <addr>         Address to bind, default 127.0.0.1 (0.0.0.0 in Docker) [CARDINAL_HOST]
  --allow-hosts <list>  Only proxy to these hosts: host, host:port or *.domain, comma-separated [CARDINAL_ALLOW_HOSTS]
  --origin <origin>     Also allow this origin to use the relay; repeatable [CARDINAL_ORIGINS]
  --public-hosts <list> Host names the server is reached by, besides localhost and IPs [CARDINAL_PUBLIC_HOSTS]
  --static <dir>        Serve the app from a directory instead of the embedded build
  --version             Print the version
  --help                Show this help

The relay token for cross-origin use is random per start; set CARDINAL_RELAY_TOKEN to keep it.
${HOSTED_ORIGIN} is always an allowed relay origin.`

export class ConfigError extends Error {}

function list(value: string | undefined) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`Invalid origin: ${value}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`Origin must be http(s): ${value}`)
  return url.origin
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Flags win over environment variables. Throws ConfigError on bad input. */
export function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): RelayConfig {
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!match) throw new ConfigError(`Unknown argument: ${arg}`)
    const [, name, inline] = match
    if (!["port", "host", "allow-hosts", "origin", "public-hosts", "static"].includes(name)) throw new ConfigError(`Unknown option: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new ConfigError(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  const flag = (name: string) => flags.get(name)?.at(-1)

  const portText = flag("port") ?? env.CARDINAL_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid port: ${portText}`)

  const origins = [HOSTED_ORIGIN, ...list(env.CARDINAL_ORIGINS), ...(flags.get("origin") ?? []).flatMap(list)].map(normalizeOrigin)
  const configuredToken = env.CARDINAL_RELAY_TOKEN?.trim()
  if (configuredToken !== undefined && configuredToken !== "" && configuredToken.length < 16) {
    throw new ConfigError("CARDINAL_RELAY_TOKEN must be at least 16 characters")
  }

  return {
    port,
    host: flag("host") ?? env.CARDINAL_HOST ?? "127.0.0.1",
    allowHosts: list(flag("allow-hosts") ?? env.CARDINAL_ALLOW_HOSTS),
    origins: [...new Set(origins)],
    publicHosts: list(flag("public-hosts") ?? env.CARDINAL_PUBLIC_HOSTS).map((host) => host.toLowerCase()),
    relayToken: configuredToken || randomToken(),
    tokenGenerated: !configuredToken,
    staticDir: flag("static"),
  }
}
