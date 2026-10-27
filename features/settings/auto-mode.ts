import { autoModes, type TransportContext } from "@/lib/core/transport-plan"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import { CorsError, isGrafanaCloudHost, supportsLocalNetworkAccess, type TransportMode } from "@/lib/sources/transport"
import { useServerStore } from "@/lib/store/server-store"

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
  const { server } = useServerStore.getState()
  return {
    privateHost: hostname ? isPrivateHost(hostname) : false,
    cloudHost: isGrafanaCloudHost(baseUrl),
    selfHosted: server !== null,
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
  // Nothing can work (plain http on a private host): try direct so the check explains why.
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

/** How a connection is routed, in a few words. */
export function routeLabel(mode: TransportMode, selfHosted: boolean) {
  if (mode === "proxy") return selfHosted ? "via this server" : "via Cardinal's proxy"
  return "directly from this browser"
}

/** Who besides the backend sees a connection's requests and token, in one sentence. */
export function routePrivacy(mode: TransportMode, selfHosted: boolean) {
  if (mode === "proxy") {
    return selfHosted
      ? "Requests go through the Cardinal server you run. Cardinal's hosted servers never see them."
      : "Requests and your token pass through Cardinal's servers on the way to the backend. They are not stored or logged."
  }
  return "The browser calls the backend itself. Cardinal's servers never see the requests or the token."
}
