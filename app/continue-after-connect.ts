import { signalFromPath, type Signal } from "@/lib/core/signals"

// A deep link (e.g. from the exported Grafana dashboard) opened without a
// connection: remember where it pointed, so connecting from the overview
// brings the user back there. Per tab, like history.

const KEY = "cardinal.nav.afterConnect"

export function rememberNextPath(path: string) {
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Storage blocked: continuing is best effort.
  }
}

/** The remembered path for a signal, removed once read. */
export function takeNextPath(signal: Signal): string | null {
  try {
    const path = sessionStorage.getItem(KEY)
    if (!path || signalFromPath(path.split(/[?#]/)[0]) !== signal) return null
    sessionStorage.removeItem(KEY)
    return path
  } catch {
    return null
  }
}
