export const DEFAULT_PORT = 9181

export interface ServerConfig {
  port: number
  host: string
  /** Proxy targets allowed (lib/proxy/core isHostAllowed); empty allows all, private hosts included. */
  allowHosts: string[]
  /** Host names this server is reached by, besides localhost and IP addresses (DNS rebinding guard). */
  publicHosts: string[]
  /** Serve the app from this directory instead of the embedded copy. */
  staticDir?: string
}

export const USAGE = `cardinal: Cardinal on your own machine or network, for any Prometheus, Loki and Grafana

Usage: cardinal [options]
       cardinal healthcheck

Options (environment variable in brackets):
  --port <n>            Port to listen on, default ${DEFAULT_PORT} [CARDINAL_PORT]
  --host <addr>         Address to bind, default 127.0.0.1 (0.0.0.0 in Docker) [CARDINAL_HOST]
  --allow-hosts <list>  Only proxy to these hosts: host, host:port or *.domain, comma-separated [CARDINAL_ALLOW_HOSTS]
  --public-hosts <list> Host names the server is reached by, besides localhost and IPs [CARDINAL_PUBLIC_HOSTS]
  --static <dir>        Serve the app from a directory instead of the embedded build
  --version             Print the version
  --help                Show this help`

export class ConfigError extends Error {}

function list(value: string | undefined) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Flags win over environment variables. Throws ConfigError on bad input. */
export function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): ServerConfig {
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!match) throw new ConfigError(`Unknown argument: ${arg}`)
    const [, name, inline] = match
    if (!["port", "host", "allow-hosts", "public-hosts", "static"].includes(name)) throw new ConfigError(`Unknown option: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new ConfigError(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  const flag = (name: string) => flags.get(name)?.at(-1)

  const portText = flag("port") ?? env.CARDINAL_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid port: ${portText}`)

  return {
    port,
    host: flag("host") ?? env.CARDINAL_HOST ?? "127.0.0.1",
    allowHosts: list(flag("allow-hosts") ?? env.CARDINAL_ALLOW_HOSTS),
    publicHosts: list(flag("public-hosts") ?? env.CARDINAL_PUBLIC_HOSTS).map((host) => host.toLowerCase()),
    staticDir: flag("static"),
  }
}
