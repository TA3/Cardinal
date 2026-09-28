import * as React from "react"
import { ArrowsClockwiseIcon, ChartBarIcon, LinkBreakIcon, PencilSimpleIcon, ScrollIcon } from "@phosphor-icons/react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { useShellActions } from "@/app/shell/shell-actions"
import { LiveDot } from "@/components/motion"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { hostOf, useGrafanaLink } from "@/features/grafana/via-grafana"
import { routeLabel } from "@/features/settings/auto-mode"
import { ConnectionForm } from "@/features/settings/connection-form"
import { useBackendProfile, useNeedsTokenFor } from "@/hooks/use-cardinality"
import { BACKEND_NAMES } from "@/lib/core/backend-profile"
import type { Signal } from "@/lib/core/signals"
import { hasAdaptiveLogs } from "@/lib/sources/adaptive-logs"
import { currentConnection, useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/relay-store"
import { cn } from "@/lib/utils"

type Status = "connected" | "token" | "error" | "none"

const STATUS: Record<Status, { label: string; className: string }> = {
  connected: { label: "Connected", className: "border-brand/30 text-brand-ink" },
  token: { label: "Token needed", className: "border-amber-500/40 text-amber-700 dark:text-amber-400" },
  error: { label: "Credentials rejected", className: "border-destructive/40 text-destructive" },
  none: { label: "Not connected", className: "text-muted-foreground" },
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={STATUS[status].className}>
      <LiveDot className="size-1.5" pulse={status === "connected"} />
      {STATUS[status].label}
    </Badge>
  )
}

/** What the backend is, as far as Cardinal knows. */
function useBackendName(signal: Signal) {
  const profile = useBackendProfile()
  const settings = useAppStore((state) => (signal === "logs" ? state.logsSettings : state.settings))
  if (signal === "metrics") return profile ? `${BACKEND_NAMES[profile.kind]}${profile.version ? ` ${profile.version}` : ""}` : "Detecting…"
  const connection = currentConnection(settings)
  return connection && hasAdaptiveLogs(connection) ? "Grafana Cloud Logs" : "Loki"
}

function Fact({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex min-w-0 items-center rounded-full border border-well-border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground", className)}>{children}</span>
}

function DisconnectButton({ signal, name }: { signal: Signal; name: string }) {
  const disconnect = useAppStore((state) => state.disconnectSignal)
  const noun = signal === "logs" ? "logs" : "metrics"
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <LinkBreakIcon data-icon="inline-start" />
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Disconnect {noun} from {name}?
          </AlertDialogTitle>
          <AlertDialogDescription>Cardinal forgets this connection and its snapshot. Rules stay.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              disconnect(signal)
              toast.success(`Disconnected ${noun}`)
            }}
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Settings → Data sources: one card per signal. Connected, it is a status
 * line (host, backend, route) with Edit and Disconnect; otherwise, or while
 * editing, the connection form.
 */
export function DataSourceCard({ signal }: { signal: Signal }) {
  const navigate = useNavigate()
  const settings = useAppStore((state) => (signal === "logs" ? state.logsSettings : state.settings))
  const authError = useAppStore((state) => (signal === "logs" ? state.logsAuthError : state.authError))
  const locked = useNeedsTokenFor(signal)
  const link = useGrafanaLink(signal)
  const selfHosted = useSelfHosted()
  const backend = useBackendName(signal)
  const { openGrafanaConnect } = useShellActions()
  const [editing, setEditing] = React.useState(false)
  const baseUrl = settings.baseUrl.trim()
  const connected = Boolean(baseUrl)
  // The header pill links to #logs-connection; Settings scrolls to it.
  const cardId = signal === "logs" ? "logs-connection" : "connection"

  const status: Status = !connected ? "none" : authError ? "error" : locked ? "token" : "connected"
  const Icon = signal === "logs" ? ScrollIcon : ChartBarIcon
  const route = link ? null : routeLabel(settings.mode, selfHosted)
  const showForm = !connected || editing || status === "token"

  return (
    <Card id={cardId} className="scroll-mt-32">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {signal === "logs" ? "Logs" : "Metrics"}
        </CardTitle>
        <CardAction>
          <StatusBadge status={status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connected ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-sm" title={baseUrl}>
                {hostOf(baseUrl)}
              </span>
              <Fact>{backend}</Fact>
              {link ? <Fact className="text-brand-ink">via Grafana · {link.name}</Fact> : null}
              {route ? <Fact>{route}</Fact> : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {link ? (
                <Button type="button" variant="outline" size="sm" onClick={openGrafanaConnect}>
                  <ArrowsClockwiseIcon data-icon="inline-start" />
                  Change
                </Button>
              ) : null}
              {!editing ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <PencilSimpleIcon data-icon="inline-start" />
                  Edit
                </Button>
              ) : null}
              <DisconnectButton signal={signal} name={link?.name ?? hostOf(baseUrl)} />
            </div>
          </div>
        ) : null}
        {showForm ? (
          <div className={cn(connected && "border-t border-well-border pt-4")}>
            <ConnectionForm
              signal={signal}
              onCancel={connected && status !== "token" ? () => setEditing(false) : undefined}
              onConnected={() => {
                setEditing(false)
                if (!connected) navigate(signal === "logs" ? paths.logs : paths.overview)
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
