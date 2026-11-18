// Running Cardinal yourself: the commands the app shows, in one place. The
// server (server/) serves the whole app and its proxy on your machine; with
// --allow-origin it is also the proxy for another page, like the hosted app.

export { LOCAL_APP_URL } from "@/lib/core/handoff"

/** Needs Node 20 or later. */
export const NPX_COMMAND = "npx @ta3/cardinal"

/** Installs the single-file binary, checked against the release's SHA256SUMS. */
export const INSTALL_SCRIPT = "curl -fsSL https://github.com/TA3/cardinal/releases/latest/download/install.sh | sh"

/** Published on loopback only: the container listens on every interface inside. */
export const DOCKER_COMMAND = "docker run -p 127.0.0.1:9181:9181 ghcr.io/ta3/cardinal"

export const RELEASES_URL = "https://github.com/TA3/cardinal/releases/latest"

export type InstallMethod = "npx" | "binary" | "docker"

/** The command that starts Cardinal by `method`, letting `origin` (a page like the hosted app) use it as its proxy when given. */
export function startCommand(method: InstallMethod, origin?: string) {
  const flag = origin ? ` --allow-origin ${origin}` : ""
  switch (method) {
    case "npx":
      return `${NPX_COMMAND}${flag}`
    case "binary":
      return `cardinal${flag}`
    case "docker":
      return `${DOCKER_COMMAND}${flag}`
  }
}

/** The one-liner that makes a Cardinal server the proxy for `origin`. */
export function proxyCommand(origin: string) {
  return startCommand("npx", origin)
}

export const LOCAL_HTTPS_URL = "https://localhost:9181"

/** The server's options worth knowing, for the self-host page; `cardinal --help` lists them all. */
export const SERVER_OPTIONS: ReadonlyArray<{ flag: string; what: string }> = [
  { flag: "--allow-origin <site>", what: "Lets a site, like this one, use it as its proxy. Repeat it for more." },
  { flag: "--allow-hosts <list>", what: "Only proxies to these backends: host, host:port or *.domain." },
  { flag: "--tls-cert <file> --tls-key <file>", what: "Serves HTTPS with your certificate. Safari needs it to let an https page in." },
  { flag: "--proxy-via <url>", what: "Reaches backends through your HTTP proxy. HTTPS_PROXY and NO_PROXY work too." },
  { flag: "--proxy-ca <file>", what: "Trusts your internal CA for backends, as well as the usual ones." },
  { flag: "--proxy-timeout <s>", what: "Waits longer for slow queries: 30 s by default, at most 240." },
  { flag: "--debug", what: "Logs every request: path, backend, status, time and why it failed. Never credentials." },
  { flag: "--port <n>", what: "Listens on another port than 9181." },
  { flag: "--open", what: "Opens the app in your browser once it starts." },
]
