import * as React from "react"
import { ClipboardTextIcon, XIcon } from "@phosphor-icons/react"
import { Link, useLocation } from "react-router"

import { paths } from "@/app/paths"
import { Button } from "@/components/ui/button"
import { useSignal } from "@/hooks/use-signal"
import { useAppStore } from "@/lib/store/app-store"

const DISMISSED_KEY = "cardinal.offlineBanner.dismissed"

function wasDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * One short line on pages viewing a pasted snapshot; each live-only section
 * says what it needs itself. Dismissed once, for good, in this browser.
 */
export function OfflineBanner() {
  const signal = useSignal()
  const { pathname } = useLocation()
  const pasted = useAppStore((state) =>
    signal === "logs"
      ? Boolean(state.logsSnapshot?.imported) && !state.logsSettings.baseUrl.trim()
      : state.snapshot?.method === "import" && !state.settings.baseUrl.trim()
  )
  const [dismissed, setDismissed] = React.useState(wasDismissed)
  if (dismissed || !pasted || pathname.startsWith(paths.settings)) return null
  return (
    <div role="note" className="mb-4 flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <ClipboardTextIcon className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        Pasted snapshot: some sections need a live connection.{" "}
        <Link to={`${paths.settings}#${signal === "logs" ? "logs-connection" : "connection"}`} className="text-foreground underline underline-offset-2">
          Connect
        </Link>
      </p>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(DISMISSED_KEY, "1")
          } catch {
            // storage blocked: hidden for this tab only
          }
        }}
      >
        <XIcon />
      </Button>
    </div>
  )
}
