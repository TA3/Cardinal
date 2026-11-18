export const DEFAULT_PORT = 9181

/** Seconds the proxy waits for a backend by default (lib/proxy/core). */
export const DEFAULT_PROXY_TIMEOUT = 30

/** Bun closes idle connections after at most 255 s, so the proxy can't wait much longer than this. */
export const MAX_PROXY_TIMEOUT = 240

export interface ServerConfig {
  port: number
  host: string
  /** Proxy targets allowed (lib/proxy/core isHostAllowed); empty allows all, private hosts included. */
  allowHosts: string[]
  /** Host names this server is reached by, besides localhost and IP addresses (DNS rebinding guard). */
  publicHosts: string[]
  /** Other sites (origins) that may use this server as their proxy, e.g. the hosted app. */
  allowOrigins: string[]
  /** Serve the app from this directory instead of the embedded copy. */
  staticDir?: string
  /** HTTPS with this certificate and key (PEM files); plain http without. */
  tls?: { cert: string; key: string }
  /** Seconds the proxy waits for a backend before answering 504. */
  proxyTimeout: number
  /** Send every backend request through this HTTP proxy. Without it, HTTPS_PROXY, HTTP_PROXY and NO_PROXY apply. */
  proxyVia?: string
  /** Also trust this CA (PEM file) for backends, e.g. a company's internal one. */
  proxyCa?: string
  /** Log a line per API request: path, backend, status and time, never headers, credentials or query strings. */
  debug: boolean
  /** Open the app in the browser once the server listens. */
  open: boolean
}

export const USAGE = `cardinal: Cardinal on your own machine or network, for any Prometheus, Loki and Grafana

Usage: cardinal [options]
       cardinal healthcheck

Options take an environment variable instead, in brackets.

Server:
  --port <n>              Port to listen on, default ${DEFAULT_PORT} [CARDINAL_PORT]
  --host <addr>           Address to bind, default 127.0.0.1 (0.0.0.0 in Docker) [CARDINAL_HOST]
  --public-hosts <list>   Host names it is reached by, besides localhost and IPs [CARDINAL_PUBLIC_HOSTS]
  --tls-cert <file>       Serve HTTPS with this certificate (PEM) [CARDINAL_TLS_CERT]
  --tls-key <file>        The certificate's private key (PEM) [CARDINAL_TLS_KEY]
  --static <dir>          Serve the app from a directory instead of the embedded build
  --open                  Open the app in your browser once it starts [CARDINAL_OPEN]

Proxy:
  --allow-origin <list>   Sites that may use it as their proxy, e.g. https://cardinal.ta3.dev [CARDINAL_ALLOW_ORIGINS]
  --allow-hosts <list>    Only proxy to these hosts: host, host:port or *.domain [CARDINAL_ALLOW_HOSTS]
  --proxy-timeout <s>     Seconds to wait for a backend, default ${DEFAULT_PROXY_TIMEOUT}, at most ${MAX_PROXY_TIMEOUT} [CARDINAL_PROXY_TIMEOUT]
  --proxy-via <url>       Reach every backend through this HTTP proxy [CARDINAL_PROXY_VIA]
                          Without it, HTTPS_PROXY, HTTP_PROXY and NO_PROXY apply
  --proxy-ca <file>       Also trust this CA (PEM) for backends, e.g. your internal one [CARDINAL_PROXY_CA]
                          A self-signed backend: turn on Skip certificate check for it in the app

Troubleshooting:
  --debug                 Log each request: path, backend, status and time; never credentials [CARDINAL_DEBUG]
  --version               Print the version
  --help                  Show this help`

export class ConfigError extends Error {}

const VALUE_OPTIONS = ["port", "host", "allow-hosts", "public-hosts", "allow-origin", "tls-cert", "tls-key", "static", "proxy-timeout", "proxy-via", "proxy-ca"]
/** On when given; `--debug=false` turns one off again. */
const SWITCHES = ["debug", "open"]

/** `https://host[:port]`, as browsers send it in Origin. Throws ConfigError on anything else. */
function origin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`Invalid origin: ${value} (expected e.g. https://cardinal.ta3.dev)`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new ConfigError(`Invalid origin: ${value} (scheme, host and port only, e.g. https://cardinal.ta3.dev)`)
  }
  return url.origin
}

/** An HTTP proxy's URL, credentials allowed (http://user:pass@proxy:3128). */
function proxyUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`Invalid proxy URL: ${value} (expected e.g. http://proxy.internal:3128)`)
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new ConfigError(`Invalid proxy URL: ${value} (http:// or https:// only)`)
  return url.href.replace(/\/$/, "")
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function truthy(name: string, value: string) {
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off|)$/i.test(value)) return false
  throw new ConfigError(`Invalid value for ${name}: ${value} (true or false)`)
}

/** Flags win over environment variables. Throws ConfigError on bad input. */
export function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): ServerConfig {
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!match) throw new ConfigError(`Unknown argument: ${arg}`)
    const [, name, inline] = match
    let value: string | undefined
    if (SWITCHES.includes(name)) value = inline ?? "true"
    else if (VALUE_OPTIONS.includes(name)) value = inline ?? argv[++index]
    else throw new ConfigError(`Unknown option: --${name}`)
    if (value === undefined) throw new ConfigError(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  const flag = (name: string) => flags.get(name)?.at(-1)
  const on = (name: string, envName: string) => {
    const value = flag(name)
    if (value !== undefined) return truthy(`--${name}`, value)
    return env[envName] !== undefined && truthy(envName, env[envName])
  }

  const portText = flag("port") ?? env.CARDINAL_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid port: ${portText}`)

  const timeoutText = flag("proxy-timeout") ?? env.CARDINAL_PROXY_TIMEOUT ?? String(DEFAULT_PROXY_TIMEOUT)
  const proxyTimeout = Number(timeoutText)
  if (!Number.isFinite(proxyTimeout) || proxyTimeout < 1 || proxyTimeout > MAX_PROXY_TIMEOUT) {
    throw new ConfigError(`Invalid proxy timeout: ${timeoutText} (seconds, 1 to ${MAX_PROXY_TIMEOUT})`)
  }

  const cert = flag("tls-cert") ?? env.CARDINAL_TLS_CERT
  const key = flag("tls-key") ?? env.CARDINAL_TLS_KEY
  if (Boolean(cert) !== Boolean(key)) throw new ConfigError("HTTPS needs both --tls-cert and --tls-key")

  const via = flag("proxy-via") ?? env.CARDINAL_PROXY_VIA
  const ca = flag("proxy-ca") ?? env.CARDINAL_PROXY_CA

  return {
    port,
    host: flag("host") ?? env.CARDINAL_HOST ?? "127.0.0.1",
    allowHosts: list(flag("allow-hosts") ?? env.CARDINAL_ALLOW_HOSTS),
    publicHosts: list(flag("public-hosts") ?? env.CARDINAL_PUBLIC_HOSTS).map((host) => host.toLowerCase()),
    // Repeatable, unlike the other lists: each --allow-origin adds sites.
    allowOrigins: Array.from(new Set(list(flags.get("allow-origin")?.join(",") ?? env.CARDINAL_ALLOW_ORIGINS).map(origin))),
    staticDir: flag("static"),
    ...(cert && key ? { tls: { cert, key } } : {}),
    proxyTimeout,
    ...(via ? { proxyVia: proxyUrl(via) } : {}),
    ...(ca ? { proxyCa: ca } : {}),
    debug: on("debug", "CARDINAL_DEBUG"),
    open: on("open", "CARDINAL_OPEN"),
  }
}
