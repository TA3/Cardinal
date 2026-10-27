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

