import { create } from "zustand"
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware"

import type { RelayInfo } from "@/lib/sources/proxy-constants"
import { configureRelay, type RelayTarget } from "@/lib/sources/transport"

// The relay (a self-hosted `cardinal` server) that Relay mode sends requests
// to, shared by metrics, logs and Grafana; and, when this page is itself
// served by a self-hosted server, that server's info.

interface RelayState {
  relay: RelayTarget
  /** The self-hosted server serving this page; null on the hosted app. Not persisted. */
  server: RelayInfo | null
  /** Detection of `server` has finished. Not persisted. */
  serverChecked: boolean
  setRelay: (patch: Partial<RelayTarget>) => void
  setServer: (server: RelayInfo | null) => void
}

const storage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
    } catch {
      // Private mode or full storage: the relay stays set for this tab.
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // ignore
    }
  },
}

export const useRelayStore = create<RelayState>()(
  persist(
    (set) => ({
      relay: { url: "", token: "" },
      server: null,
      serverChecked: false,
      setRelay: (patch) => set((state) => ({ relay: { ...state.relay, ...patch } })),
      setServer: (server) => set({ server, serverChecked: true }),
    }),
    {
      name: "cardinal.relay.v1",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ relay: state.relay }),
    }
  )
)

configureRelay(useRelayStore.getState().relay)
useRelayStore.subscribe((state, previous) => {
  if (state.relay !== previous.relay) configureRelay(state.relay)
})

/** True when this page is served by a self-hosted `cardinal` server, whose proxy reaches private hosts. */
export function useSelfHosted() {
  return useRelayStore((state) => state.server !== null)
}

/** Relay mode is usable: a relay URL is set. */
export function useRelayConfigured() {
  return useRelayStore((state) => Boolean(state.relay.url.trim()))
}
