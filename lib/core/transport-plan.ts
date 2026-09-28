/** lib/sources/transport's TransportMode (lib/core stays free of the source layer). */
type TransportMode = "direct" | "proxy" | "relay"

// Auto mode for a connection: which transports to try, in order. Direct
// first (nothing passes through Cardinal), then the proxy for public hosts
// that don't send CORS headers. Private hosts can't use the hosted proxy:
// they need a relay or a self-hosted Cardinal server.

export interface TransportContext {
  /** The backend's host is private or local (see isPrivateHost). */
  privateHost: boolean
  /** A Grafana Cloud host: it never allows browser requests. */
  cloudHost: boolean
  /** This page is served by a self-hosted Cardinal server, whose proxy reaches private hosts. */
  selfHosted: boolean
  /** A relay is configured in Settings. */
  relaySet: boolean
}

export function autoModes({ privateHost, cloudHost, selfHosted, relaySet }: TransportContext): TransportMode[] {
  if (cloudHost) return ["proxy"]
  if (privateHost) return selfHosted ? ["direct", "proxy"] : relaySet ? ["direct", "relay"] : ["direct"]
  return ["direct", "proxy"]
}

/** The private host needs somewhere else to connect from: auto mode ran out of options. */
export function needsRelay(context: TransportContext) {
  return context.privateHost && !context.selfHosted && !context.relaySet
}
