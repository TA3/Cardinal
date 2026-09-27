import * as React from "react"
import { KeyIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useNeedsTokenFor, useRefreshSignalSnapshot } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { useAppStore } from "@/lib/store/app-store"

/**
 * Asks for the token again when the connection needs one this tab doesn't have,
 * e.g. after a reload with "remember token" off, or after a 401.
 */
export function TokenBanner() {
  // The signal in view: logs pages ask for the logs token, everything else for the metrics one.
  const signal = useSignal()
  const logs = signal === "logs"
  const show = useNeedsTokenFor(signal)
  const rejected = useAppStore((state) => (logs ? state.logsAuthError && Boolean(state.logsSettings.token) : state.authError && Boolean(state.settings.token)))
  const baseUrl = useAppStore((state) => (logs ? state.logsSettings.baseUrl : state.settings.baseUrl))
  const updateSettings = useAppStore((state) => (logs ? state.updateLogsSettings : state.updateSettings))
  const { refresh, isPending } = useRefreshSignalSnapshot(signal)
  const queryClient = useQueryClient()
  const [token, setToken] = React.useState("")

  let host = baseUrl
  try {
    host = new URL(baseUrl).host
  } catch {
    // keep the raw value
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!token.trim()) return
    updateSettings({ token: token.trim() })
    setToken("")
    void queryClient.invalidateQueries()
    refresh()
  }

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.form
          key="token-banner"
          onSubmit={submit}
          initial={{ opacity: 0, y: -6, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
          transition={{ duration: 0.2 }}
          role="region"
          aria-label="Token required"
          className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3 sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5 text-sm">
            <KeyIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="font-medium">{rejected ? "The token was rejected" : "Token needed"}</p>
              <p className="text-muted-foreground">
                {rejected
                  ? `${host} answered 401 Unauthorized. Enter a valid token to reconnect.`
                  : `The token for ${host} isn't remembered on this device. Enter it to reconnect.`}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              aria-label="Token"
              placeholder="Token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="sm:w-56"
            />
            <Button type="submit" disabled={!token.trim() || isPending}>
              Reconnect
            </Button>
          </div>
        </motion.form>
      ) : null}
    </AnimatePresence>
  )
}
