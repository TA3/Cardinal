import * as React from "react"
import { ArrowsLeftRightIcon } from "@phosphor-icons/react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { readHandoffHash, type Handoff, type HandoffConnection } from "@/lib/core/handoff"
import { inferAuthMode } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

// The receiving end of "Continue on your machine" (lib/core/handoff): a link
// to this app whose #fragment carries another Cardinal's work. Nothing is
// applied until the user confirms, since anyone can craft such a link.

function readFromLocation(): { handoff: Handoff | null; error: string | null } {
  try {
    return { handoff: readHandoffHash(globalThis.location?.hash ?? ""), error: null }
  } catch (error) {
    return { handoff: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function clearHash() {
  const { pathname, search } = globalThis.location
  history.replaceState(history.state, "", `${pathname}${search}`)
}

/** Settings for a connection that arrived without its token; the route is picked again here. */
function connectionPatch(connection: HandoffConnection) {
  const fields = { baseUrl: connection.baseUrl, instanceId: connection.instanceId ?? "", tenant: connection.tenant ?? "", token: "" }
  return { ...fields, authMode: inferAuthMode(fields), mode: "proxy" as const, modeManual: false }
}

function apply(handoff: Handoff) {
  const state = useAppStore.getState()
  if (handoff.metrics) state.updateSettings(connectionPatch(handoff.metrics))
  if (handoff.logs) state.updateLogsSettings(connectionPatch(handoff.logs))
  if (handoff.grafana) state.updateGrafanaSettings({ baseUrl: handoff.grafana.baseUrl })
  if (handoff.rules.length) state.addRules(handoff.rules)
  if (handoff.logRules.length) state.addLogRules(handoff.logRules)
  const prices = {
    ...(handoff.prices.perSeries !== undefined ? { pricePer1kSeries: handoff.prices.perSeries } : {}),
    ...(handoff.prices.perGB !== undefined ? { pricePerGB: handoff.prices.perGB } : {}),
  }
  if (Object.keys(prices).length) state.updateSettings(prices)
  if (handoff.autopilot) state.setAutopilot(true)
  if (handoff.attribution) useAppStore.setState({ attribution: handoff.attribution })
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export function HandoffDialog() {
  const navigate = useNavigate()
  const [{ handoff, error }] = React.useState(readFromLocation)
  const [open, setOpen] = React.useState(Boolean(handoff))

  React.useEffect(() => {
    if (!error) return
    clearHash()
    toast.error("Couldn't read that link", { description: error })
  }, [error])

  if (!handoff) return null
  const connections = [
    handoff.metrics ? { name: "Metrics", url: handoff.metrics.baseUrl } : null,
    handoff.logs ? { name: "Logs", url: handoff.logs.baseUrl } : null,
    handoff.grafana ? { name: "Grafana", url: handoff.grafana.baseUrl } : null,
  ].filter((item) => item !== null)
  const extras = [
    handoff.rules.length ? plural(handoff.rules.length, "metric rule") : null,
    handoff.logRules.length ? plural(handoff.logRules.length, "log rule") : null,
    handoff.prices.perSeries !== undefined || handoff.prices.perGB !== undefined ? "prices" : null,
    handoff.attribution ? "attribution" : null,
    handoff.autopilot ? "autopilot" : null,
  ].filter(Boolean)

  const close = () => {
    clearHash()
    setOpen(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ArrowsLeftRightIcon className="size-4 text-muted-foreground" />
            Continue here?
          </AlertDialogTitle>
          <AlertDialogDescription>
            A link brought work from another Cardinal. Check the addresses before you continue: your token is never carried, so you&apos;ll enter
            it again here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          {connections.map((item) => (
            <div key={item.name} className="flex min-w-0 items-baseline gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">{item.name}</span>
              <span className="min-w-0 truncate font-mono text-xs" title={item.url}>
                {item.url}
              </span>
            </div>
          ))}
          {extras.length ? <p className="text-muted-foreground">Also: {extras.join(", ")}. Rules are added to any you have here.</p> : null}
          {handoff.warnings.length ? <p className="text-xs text-muted-foreground">{plural(handoff.warnings.length, "item")} couldn&apos;t be read and was left out.</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              apply(handoff)
              close()
              toast.success("Brought over", { description: connections.length ? "Enter your token to connect." : undefined })
              navigate(handoff.open === "logs" ? `${paths.settings}#logs-connection` : handoff.open === "metrics" ? `${paths.settings}#connection` : paths.plan)
            }}
          >
            Bring it over
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
