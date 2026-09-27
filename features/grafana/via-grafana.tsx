import { ArrowsClockwiseIcon, CloudIcon, LinkBreakIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useShellActions } from "@/app/shell/shell-actions"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { activeLink, type GrafanaDatasourceLink } from "@/lib/core/grafana-connect"
import type { Signal } from "@/lib/core/signals"
import { useAppStore } from "@/lib/store/app-store"

export function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The signal's Grafana link while its URL is still the one Connect Grafana applied. */
export function useGrafanaLink(signal: Signal): GrafanaDatasourceLink | null {
  return useAppStore((state) => activeLink(state.grafanaLinks[signal], signal === "logs" ? state.logsSettings.baseUrl : state.settings.baseUrl))
}

/** "via Grafana: <data source>" above a connection form, with Change and Disconnect. Nothing when the signal isn't connected through Grafana. */
export function ViaGrafana({ signal }: { signal: Signal }) {
  const link = useGrafanaLink(signal)
  const disconnect = useAppStore((state) => state.disconnectSignal)
  const { openGrafanaConnect } = useShellActions()
  if (!link) return null
  const noun = signal === "logs" ? "logs" : "metrics"
  return (
    <div
      data-slot="via-grafana"
      className="flex flex-col gap-3 rounded-2xl border border-well-border bg-well px-3.5 py-3 [corner-shape:squircle] sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {link.via === "cloud" ? (
          <CloudIcon className="mt-0.5 size-4 shrink-0 text-brand-ink" />
        ) : (
          <SquaresFourIcon className="mt-0.5 size-4 shrink-0 text-brand-ink" />
        )}
        <div className="flex min-w-0 flex-col">
          <p className="truncate text-sm">
            <span className="text-muted-foreground">{link.via === "cloud" ? "Grafana Cloud, from " : "via Grafana: "}</span>
            <span className="font-medium">{link.name}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {link.via === "cloud" ? `Direct to ${hostOf(link.baseUrl)} (Adaptive APIs available)` : `${hostOf(link.grafanaUrl)} data source proxy`}. You can
            still edit the URL below.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="outline" size="sm" onClick={openGrafanaConnect}>
          <ArrowsClockwiseIcon data-icon="inline-start" />
          Change
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <LinkBreakIcon data-icon="inline-start" />
              Disconnect
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {noun} from {link.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Cardinal forgets this {noun} connection and its snapshot. Rules stay, and the Grafana connection stays for the other signal,
                the dashboard scan and export.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  disconnect(signal)
                  toast.success(`Disconnected ${noun}`, { description: `No longer reading ${noun} from ${link.name}.` })
                }}
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
