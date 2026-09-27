import * as React from "react"
import { PlugsConnectedIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { Link, useLocation } from "react-router"

import { rememberNextPath } from "@/app/continue-after-connect"
import { paths } from "@/app/paths"
import { useShellActions } from "@/app/shell/shell-actions"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import type { Snapshot } from "@/lib/core/snapshot"
import { useAppStore } from "@/lib/store/app-store"

/** Deep links (e.g. from the exported Grafana dashboard) land here without data: connect, then continue to this page. */
function ConnectActions({ to, label }: { to: string; label: string }) {
  const { pathname, search } = useLocation()
  const { openGrafanaConnect } = useShellActions()
  const here = `${pathname}${search}`
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link to={to} onClick={() => rememberNextPath(here)}>
            {label}
          </Link>
        </Button>
        <Button type="button" variant="outline" onClick={openGrafanaConnect}>
          <SquaresFourIcon data-icon="inline-start" />
          Connect Grafana
        </Button>
      </div>
      {here !== to ? <p className="text-xs text-muted-foreground">Once connected, Cardinal continues to this page.</p> : null}
    </div>
  )
}

/** Renders children with the snapshot, or a prompt to connect when there is none. */
export function RequireSnapshot({ children }: { children: (snapshot: Snapshot) => React.ReactNode }) {
  const snapshot = useAppStore((state) => state.snapshot)
  if (snapshot) return children(snapshot)
  return (
    <EmptyState
      framed
      icon={PlugsConnectedIcon}
      title="No data yet"
      description="Connect a Prometheus-compatible backend and take a snapshot to explore its cardinality."
    >
      <ConnectActions to={paths.overview} label="Connect a data source" />
    </EmptyState>
  )
}

/** The logs twin: children with the logs snapshot, or a prompt to connect Loki or take a snapshot. */
export function RequireLogsSnapshot({ children }: { children: (snapshot: LogsSnapshot) => React.ReactNode }) {
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const hasSource = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  if (snapshot && hasSource) return children(snapshot)
  return (
    <EmptyState
      framed
      icon={PlugsConnectedIcon}
      title={hasSource ? "No logs snapshot yet" : "No logs source yet"}
      description={
        hasSource
          ? "Take a logs snapshot on the overview: it finds your services and labels, and this page builds on it."
          : "Connect Loki, Grafana Cloud Logs or a Grafana data source, then take a snapshot to see which streams and labels drive your volume."
      }
    >
      <ConnectActions to={paths.logs} label={hasSource ? "Take a logs snapshot" : "Connect a logs source"} />
    </EmptyState>
  )
}
