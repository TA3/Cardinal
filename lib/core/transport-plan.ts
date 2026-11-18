/** lib/sources/transport's TransportMode (lib/core stays free of the source layer). */
type TransportMode = "direct" | "proxy"

// Auto mode for a connection: which transports to try, in order. The hosted
// app has no proxy, so "proxy" means the user's own Cardinal server: the one
// serving this page, or the one set as this page's proxy. That goes first
// when there is one: no CORS, no mixed content, nobody else in the path.
// Direct is left for backends that server can't reach but the browser can.

export interface TransportContext {
  /** The backend's host is private or local (see isPrivateHost). */
  privateHost: boolean
  /** A Grafana Cloud host: it never allows browser requests. */
  cloudHost: boolean
  /** The user's own Cardinal server is there to proxy: it serves this page, or is set as this page's proxy. */
  ownServer: boolean
  /** An https page calling a plain-http backend, which browsers block as mixed content. */
  mixedContent?: boolean
  /** The browser can ask for local network access (Chrome 142+), which lifts that block for private hosts. */
  localNetworkAccess?: boolean
}

export function autoModes({ privateHost, cloudHost, ownServer, mixedContent, localNetworkAccess }: TransportContext): TransportMode[] {
  // Plain http from an https page only works directly on a private host, and only where the browser can ask for access.
  const direct: TransportMode[] = cloudHost || (mixedContent && !(privateHost && localNetworkAccess)) ? [] : ["direct"]
  return ownServer ? ["proxy", ...direct] : direct
}

/**
 * What the browser does when the hosted (https) page calls a backend on a
 * private network, said before anyone hits an error:
 * - "blocked": plain http with no way to ask for local network access (Safari, Firefox)
 * - "local-network": the browser asks to reach the network once, and the backend must allow this origin (CORS)
 * - "cors": https on the network; it works only if the backend allows this origin
 * null when nothing special applies (a public host, an http page, or the user's own server reaches it).
 */
export type LocalBackendAdvice = "blocked" | "local-network" | "cors" | null

export function localBackendAdvice({
  pageHttps,
  privateHost,
  plainHttp,
  ownServer,
  localNetworkAccess,
}: {
  pageHttps: boolean
  privateHost: boolean
  plainHttp: boolean
  ownServer: boolean
  localNetworkAccess: boolean
}): LocalBackendAdvice {
  if (!pageHttps || !privateHost || ownServer) return null
  if (localNetworkAccess) return "local-network"
  return plainHttp ? "blocked" : "cors"
}
