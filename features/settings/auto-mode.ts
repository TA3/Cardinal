import { autoModes, type TransportContext } from "@/lib/core/transport-plan"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import { CorsError, isGrafanaCloudHost, supportsLocalNetworkAccess, type TransportMode } from "@/lib/sources/transport"
import { useRelayStore } from "@/lib/store/relay-store"

// Auto mode: try each transport the backend allows (lib/core/transport-plan),
// moving on only when the browser blocked the request. Any other answer (a
// 401, a 404, a timeout) is the backend's, so it ends the search.

export function transportContext(baseUrl: string): TransportContext {
  let hostname = ""
  let protocol = ""
  try {
    ;({ hostname, protocol } = new URL(baseUrl.trim()))
  } catch {
    // an invalid URL fails later with a config problem
  }
  const { server, relay } = useRelayStore.getState()
  return {
    privateHost: hostname ? isPrivateHost(hostname) : false,
    cloudHost: isGrafanaCloudHost(baseUrl),
    selfHosted: server !== null,
    relaySet: Boolean(relay.url.trim()),
    mixedContent: globalThis.location?.protocol === "https:" && protocol === "http:",
    localNetworkAccess: supportsLocalNetworkAccess(),
  }
}

export type ModeResult<T> = { ok: true; mode: TransportMode; value: T } | { ok: false; mode: TransportMode; error: unknown }

/** Runs `attempt` in the manual mode, or in each auto mode until one isn't blocked by CORS. */
export async function withAutoMode<T>(
  baseUrl: string,
  manual: TransportMode | null,
  attempt: (mode: TransportMode) => Promise<T>
): Promise<ModeResult<T>> {
  const planned = autoModes(transportContext(baseUrl))
  // Nothing can work (plain http on a private host, no relay): try direct so the check explains why.
  const modes: TransportMode[] = manual ? [manual] : planned.length ? planned : ["direct"]
  let last: ModeResult<T> = { ok: false, mode: modes[0], error: new Error("No transport to try") }
  for (const [index, mode] of modes.entries()) {
    try {
      return { ok: true, mode, value: await attempt(mode) }
    } catch (error) {
      last = { ok: false, mode, error }
      if (!(error instanceof CorsError) || index === modes.length - 1) return last
    }
  }
  return last
}

/** How a connection is routed, in a few words; null for direct. */
export function routeLabel(mode: TransportMode, selfHosted: boolean) {
  if (mode === "relay") return "via relay"
  if (mode === "proxy") return selfHosted ? "via this server" : "via proxy"
  return null
}
