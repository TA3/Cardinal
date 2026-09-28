import * as React from "react"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LinkIcon,
  SquaresFourIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { hostOf } from "@/features/grafana/via-grafana"
import { downloadFile } from "@/features/rules/share"
import { grafanaConnection } from "@/features/usage/grafana-store"
import { explainGrafanaError } from "@/features/usage/grafana-section"
import { copyText } from "@/lib/clipboard"
import { DEFAULT_DASHBOARD_TITLE, DEFAULT_DASHBOARD_UID, grafanaDashboard, summarizeDashboard } from "@/lib/core/grafana-dashboard"
import { createDashboard, dashboardExists } from "@/lib/sources/grafana"
import { HttpError, type TransportMode } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

// Export a Grafana dashboard that mirrors Cardinal's overview and links back
// into it. Download or copy the JSON, or (with an Editor token) create it in
// the connected Grafana; an existing uid is only replaced when asked to.

function createErrorText(error: unknown, uid: string, mode: TransportMode) {
  if (error instanceof HttpError) {
    if (error.status === 403)
      return "Grafana refused (HTTP 403): creating dashboards needs the Editor role (or dashboards:create on the folder). This token looks read-only; download the JSON and import it instead, or use an Editor token."
    if (error.status === 412) return `A dashboard with uid "${uid}" already exists. Tick Overwrite to replace it, or change the uid.`
    if (error.status === 400) return `Grafana rejected the dashboard: ${error.message}`
  }
  return explainGrafanaError(error, mode)
}

function ExportFlow({ onDone }: { onDone: () => void }) {
  const hasLogs = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  const groupLabel = useAppStore((state) => state.logsSnapshot?.groupLabel ?? state.logsSettings.groupLabel ?? "service_name")
  const grafana = useAppStore((state) => state.grafanaSettings)
  const connection = grafanaConnection(grafana)
  const canCreate = Boolean(connection && grafana.token.trim())

  const [metrics, setMetrics] = React.useState(true)
  const [logs, setLogs] = React.useState(hasLogs)
  const [label, setLabel] = React.useState(groupLabel)
  const [cardinalUrl, setCardinalUrl] = React.useState(() => window.location.origin)
  const [title, setTitle] = React.useState(DEFAULT_DASHBOARD_TITLE)
  const [uid, setUid] = React.useState(DEFAULT_DASHBOARD_UID)
  const [overwrite, setOverwrite] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [created, setCreated] = React.useState<string | null>(null)
  const [createError, setCreateError] = React.useState<string | null>(null)

  const built = React.useMemo(() => {
    try {
      const dashboard = grafanaDashboard({ cardinalUrl, metrics, logs, logsGroupLabel: label, title, uid })
      return { dashboard, json: JSON.stringify(dashboard, null, 2), summary: summarizeDashboard(dashboard), error: null }
    } catch (error) {
      return { dashboard: null, json: "", summary: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [cardinalUrl, metrics, logs, label, title, uid])

  const resetResult = () => {
    setCreated(null)
    setCreateError(null)
  }

  async function copy() {
    try {
      await copyText(built.json)
      toast.success("Dashboard JSON copied", { description: "In Grafana: Dashboards → New → Import, then paste." })
    } catch {
      toast.error("Couldn't copy", { description: "Download the JSON instead." })
    }
  }

  async function create() {
    if (!connection || !built.dashboard) return
    setCreating(true)
    resetResult()
    const dashboardUid = String(built.dashboard.uid)
    try {
      if (!overwrite) {
        const existing = await dashboardExists(connection, dashboardUid, AbortSignal.timeout(15_000))
        if (existing.exists) {
          setCreateError(
            `A dashboard with uid "${dashboardUid}" already exists${existing.title ? ` ("${existing.title}")` : ""}. Tick Overwrite to replace it, or change the uid.`
          )
          return
        }
      }
      const result = await createDashboard(connection, built.dashboard, { overwrite, message: "Created by Cardinal" })
      const href = `${connection.baseUrl}${result.url.startsWith("/") ? result.url : `/${result.url}`}`
      setCreated(href)
      toast.success(overwrite ? "Dashboard updated in Grafana" : "Dashboard created in Grafana", { description: href })
    } catch (error) {
      setCreateError(createErrorText(error, dashboardUid, grafana.mode))
    } finally {
      setCreating(false)
    }
  }

  const invalidLabel = logs && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label.trim())

  return (
    <>
      <DialogHeader className="px-4 pt-4">
        <DialogTitle>Export Grafana dashboard</DialogTitle>
        <DialogDescription>
          A dashboard with Cardinal's overview whose jobs, metrics and services link back here. Its data sources are variables, so it imports into
          any Grafana.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <FieldGroup className="gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="export-metrics">Metrics</FieldLabel>
                <FieldDescription>Series, series by job, top metrics, churn.</FieldDescription>
              </FieldContent>
              <Switch id="export-metrics" checked={metrics} onCheckedChange={(checked) => (setMetrics(checked), resetResult())} />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="export-logs">Logs</FieldLabel>
                <FieldDescription>Volume, streams and top values by a label.</FieldDescription>
              </FieldContent>
              <Switch id="export-logs" checked={logs} onCheckedChange={(checked) => (setLogs(checked), resetResult())} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="export-cardinal-url">Cardinal URL</FieldLabel>
              <Input id="export-cardinal-url" value={cardinalUrl} onChange={(event) => (setCardinalUrl(event.target.value), resetResult())} />
              <FieldDescription>Where the links open. Also editable later as the dashboard's cardinal_url variable.</FieldDescription>
            </Field>
            {logs ? (
              <Field data-invalid={invalidLabel || undefined}>
                <FieldLabel htmlFor="export-group-label">Logs group label</FieldLabel>
                <Input
                  id="export-group-label"
                  className="font-mono"
                  value={label}
                  aria-invalid={invalidLabel || undefined}
                  onChange={(event) => (setLabel(event.target.value), resetResult())}
                />
                <FieldDescription>Panels group streams by it; links open that group in Cardinal.</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="export-title">Title</FieldLabel>
              <Input id="export-title" value={title} onChange={(event) => (setTitle(event.target.value), resetResult())} />
            </Field>
            <Field>
              <FieldLabel htmlFor="export-uid">UID</FieldLabel>
              <Input id="export-uid" className="font-mono" value={uid} onChange={(event) => (setUid(event.target.value), resetResult())} />
            </Field>
          </div>
        </FieldGroup>

        {built.error ? (
          <Alert variant="destructive" role="alert">
            <WarningCircleIcon />
            <AlertTitle>Can't build the dashboard</AlertTitle>
            <AlertDescription>{built.error}</AlertDescription>
          </Alert>
        ) : built.summary ? (
          <div className="rounded-2xl border border-well-border bg-well px-3.5 py-3 [corner-shape:squircle]" aria-label="Preview">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <SquaresFourIcon className="size-4 text-muted-foreground" />
              <span className="font-medium">{title.trim() || DEFAULT_DASHBOARD_TITLE}</span>
              <Badge variant="outline" className="font-mono">
                {uid.trim() || DEFAULT_DASHBOARD_UID}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {built.summary.panels.length} panels · {built.summary.links} data links · {(built.summary.bytes / 1024).toFixed(1)} KB
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {built.summary.rows.map((row) => (
                <div key={row} className="min-w-0">
                  <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">{row}</p>
                  <ul className="flex flex-col gap-0.5 text-sm">
                    {built.summary!.panels
                      .filter((panel) => panel.row === row)
                      .map((panel) => (
                        <li key={panel.title} className="flex min-w-0 items-baseline justify-between gap-2">
                          <span className="truncate">{panel.title}</span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">{panel.type}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <LinkIcon className="mt-0.5 size-3.5 shrink-0" />
              Variables: {built.summary.variables.join(", ")}. The {"{__name__=~\".+\"}"} counts are heavy on large tenants; panel descriptions
              suggest recording rules.
            </p>
          </div>
        ) : null}

        <FieldSeparator />
        {canCreate ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-sm font-medium">Create in {hostOf(connection!.baseUrl)}</p>
                <p className="text-xs text-muted-foreground">Needs a token with the Editor role. Without Overwrite, an existing uid is never replaced.</p>
              </div>
              <Field orientation="horizontal" className="w-auto">
                <Checkbox id="export-overwrite" checked={overwrite} onCheckedChange={(checked) => (setOverwrite(checked === true), resetResult())} />
                <FieldLabel htmlFor="export-overwrite">Overwrite</FieldLabel>
              </Field>
            </div>
            {createError ? (
              <Alert variant="destructive" role="alert">
                <WarningCircleIcon />
                <AlertTitle>Not created</AlertTitle>
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            ) : null}
            {created ? (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-brand-ink" role="status">
                <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
                Saved in Grafana.
                <a href={created} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                  Open it
                  <ArrowSquareOutIcon className="size-3" />
                </a>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            To create it in Grafana directly, connect Grafana with an Editor token in Settings → Grafana. Or import the JSON: Dashboards → New →
            Import.
          </p>
        )}
      </div>
      <DialogFooter className="m-0 rounded-b-xl">
        <Button type="button" variant="ghost" onClick={onDone}>
          Close
        </Button>
        <Button type="button" variant="outline" disabled={!built.dashboard} onClick={() => void copy()}>
          <CopyIcon data-icon="inline-start" />
          Copy JSON
        </Button>
        <Button
          type="button"
          variant={canCreate ? "outline" : "default"}
          disabled={!built.dashboard}
          onClick={() => downloadFile(`${uid.trim() || DEFAULT_DASHBOARD_UID}.json`, built.json, "application/json")}
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Download JSON
        </Button>
        {canCreate ? (
          <Button type="button" disabled={!built.dashboard || creating} onClick={() => setConfirming(true)}>
            {creating ? <Spinner data-icon="inline-start" /> : <UploadSimpleIcon data-icon="inline-start" />}
            Create in Grafana
          </Button>
        ) : null}
      </DialogFooter>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{overwrite ? "Create or replace" : "Create"} “{title.trim() || DEFAULT_DASHBOARD_TITLE}” in Grafana?</AlertDialogTitle>
            <AlertDialogDescription>
              Cardinal sends one POST /api/dashboards/db to {connection ? hostOf(connection.baseUrl) : "Grafana"} with uid{" "}
              <code className="font-mono">{uid.trim() || DEFAULT_DASHBOARD_UID}</code>.{" "}
              {overwrite ? "An existing dashboard with this uid is replaced." : "If that uid exists, nothing is changed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={overwrite ? "destructive" : "default"} onClick={() => void create()}>
              {overwrite ? "Create or replace" : "Create"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The Export Grafana dashboard dialog; mounted once in the shell and opened through useShellActions().openGrafanaExport. */
export function ExportDashboardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 p-0 sm:max-w-2xl">
        {open ? <ExportFlow onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
