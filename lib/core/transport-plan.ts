/** lib/sources/transport's TransportMode (lib/core stays free of the source layer). */
type TransportMode = "direct" | "proxy"

// Auto mode for a connection: which transports to try, in order. Direct
// first (nothing passes through Cardinal), then the proxy for public hosts
// that don't send CORS headers. Private hosts can't use the hosted proxy:
// they need Cardinal running on that network.

export interface TransportContext {
  /** The backend's host is private or local (see isPrivateHost). */
  privateHost: boolean
  /** A Grafana Cloud host: it never allows browser requests. */
  cloudHost: boolean
  /** This page is served by a self-hosted Cardinal server, whose proxy reaches private hosts. */
  selfHosted: boolean
  /** An https page calling a plain-http backend, which browsers block as mixed content. */
  mixedContent?: boolean
  /** The browser can ask for local network access (Chrome 142+), which lifts that block for private hosts. */
  localNetworkAccess?: boolean
}

export function autoModes({ privateHost, cloudHost, selfHosted, mixedContent, localNetworkAccess }: TransportContext): TransportMode[] {
  if (cloudHost) return ["proxy"]
  // Plain http from an https page only works directly on a private host, and only where the browser can ask for access.
  const direct: TransportMode[] = mixedContent && !(privateHost && localNetworkAccess) ? [] : ["direct"]
  if (privateHost) return selfHosted ? [...direct, "proxy"] : direct
  return [...direct, "proxy"]
}


/**
 * What the browser does when the hosted (https) page calls a backend on a
 * private network, said before anyone hits an error:
 * - "blocked": plain http with no way to ask for local network access (Safari, Firefox)
 * - "local-network": the browser asks to reach the network once, and the backend must allow this origin (CORS)
 * - "cors": https on the network; it works only if the backend allows this origin
 * null when nothing special applies (a public host, an http page, or a self-hosted server whose proxy reaches it).
 */
export type LocalBackendAdvice = "blocked" | "local-network" | "cors" | null

export function localBackendAdvice({
  pageHttps,
  privateHost,
  plainHttp,
  selfHosted,
  localNetworkAccess,
}: {
  pageHttps: boolean
  privateHost: boolean
  plainHttp: boolean
  selfHosted: boolean
  localNetworkAccess: boolean
}): LocalBackendAdvice {
  if (!pageHttps || !privateHost || selfHosted) return null
  if (localNetworkAccess) return "local-network"
  return plainHttp ? "blocked" : "cors"
}
