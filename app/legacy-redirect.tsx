import { Navigate, redirect, useLocation, type LoaderFunctionArgs } from "react-router"

import { NotFound } from "@/app/route-error"
import { legacyRedirect } from "@/lib/core/signals"

/**
 * Redirects a pre-restructure URL (and "/") before anything renders. A
 * `<Navigate>` rendered into the page would hand over to a lazy page while
 * the shell's page transition still holds the redirect, which then shows
 * "not found". The hash never reaches a loader, so on the first load it is
 * read from the address bar (the handoff link carries its payload there).
 */
export function legacyLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const to = legacyRedirect(url.pathname, url.search)
  if (!to) return null
  const hash = typeof window !== "undefined" && window.location.pathname === url.pathname ? window.location.hash : ""
  throw redirect(`${to}${hash}`)
}

/** The same redirect when rendered without its loader; otherwise "not found". */
export function LegacyRedirect() {
  const { pathname, search, hash } = useLocation()
  const to = legacyRedirect(pathname, search)
  return to ? <Navigate to={`${to}${hash}`} replace /> : <NotFound />
}
