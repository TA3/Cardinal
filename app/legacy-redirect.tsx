import { Navigate, useLocation } from "react-router"

import { NotFound } from "@/app/route-error"
import { legacyRedirect } from "@/lib/core/signals"
import { useAppStore } from "@/lib/store/app-store"

/** Sends a pre-restructure URL (and "/") to its current home, keeping the query and hash. */
export function LegacyRedirect() {
  const { pathname, search, hash } = useLocation()
  const signal = useAppStore((state) => state.signal)
  const to = legacyRedirect(pathname, search, signal)
  return to ? <Navigate to={`${to}${hash}`} replace /> : <NotFound />
}
