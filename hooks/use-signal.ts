import * as React from "react"
import { useLocation, useNavigate } from "react-router"

import { signalEntry, signalFromPath, type Signal } from "@/lib/core/signals"
import { useAppStore } from "@/lib/store/app-store"

/** The signal in view: from the URL on signal routes, else the last one used. */
export function useSignal(): Signal {
  const { pathname } = useLocation()
  const stored = useAppStore((state) => state.signal)
  return signalFromPath(pathname) ?? stored
}

/** Switches signal by opening its last visited page, or its overview. */
export function useSwitchSignal() {
  const navigate = useNavigate()
  return React.useCallback(
    (signal: Signal) => {
      navigate(signalEntry(signal, useAppStore.getState().lastPathBySignal))
    },
    [navigate]
  )
}

/** Keeps the store's signal and each signal's last page in step with the URL. */
export function useTrackSignal() {
  const { pathname, search } = useLocation()
  const visitPath = useAppStore((state) => state.visitPath)
  React.useEffect(() => {
    visitPath(`${pathname}${search}`)
  }, [pathname, search, visitPath])
}
