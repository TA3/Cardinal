import { create } from "zustand"

import type { ServerInfo } from "@/lib/sources/proxy-constants"

// When this page is served by a self-hosted `cardinal` server, that server's
// info: its proxy reaches private hosts and needs no consent.

interface ServerState {
  /** The self-hosted server serving this page; null on the hosted app. */
  server: ServerInfo | null
  /** Detection of `server` has finished. */
  serverChecked: boolean
  setServer: (server: ServerInfo | null) => void
}

export const useServerStore = create<ServerState>()((set) => ({
  server: null,
  serverChecked: false,
  setServer: (server) => set({ server, serverChecked: true }),
}))

/** True when this page is served by a self-hosted `cardinal` server, whose proxy reaches private hosts. */
export function useSelfHosted() {
  return useServerStore((state) => state.server !== null)
}

// Relay mode is gone: forget its saved URL and token.
try {
  localStorage.removeItem("cardinal.relay.v1")
} catch {
  // storage blocked: nothing saved either
}
