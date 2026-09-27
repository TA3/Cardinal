import * as React from "react"
import { CaretRightIcon, DatabaseIcon, ListMagnifyingGlassIcon } from "@phosphor-icons/react"

import { EmptyState } from "@/components/empty-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { grafanaKey } from "@/features/usage/grafana-store"
import { datasourceProxyUrl, listDatasources, type DatasourceType, type GrafanaDatasource } from "@/lib/sources/grafana"
import { HttpError, type AuthMode, type TransportMode } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

// "Pick from Grafana": list the Prometheus or Loki data sources of a Grafana
// and connect through Grafana's data source proxy
// (<grafana>/api/datasources/proxy/uid/<uid>) with the Grafana token.

export interface PickedDatasource {
  baseUrl: string
  authMode: AuthMode
  token: string
  mode: TransportMode
  name: string
}

const PROXY_PATH = /\/api\/datasources\/proxy\/uid\/[^/]+\/?$/

function hostOf(url: string | undefined) {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function problemText(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403)
      return "Grafana refused the request. Anonymous access may be off: enter a service account token (Viewer role is enough)."
    if (error.status === 404) return "No Grafana API at this URL. Use the Grafana root, e.g. https://grafana.example.com."
  }
  return error instanceof Error ? error.message : String(error)
}

export function PickFromGrafana({
  type,
  currentUrl,
  onPick,
}: {
  type: DatasourceType
  /** The connection's URL now; a data source proxy URL pre-fills its Grafana root. */
  currentUrl?: string
  onPick: (picked: PickedDatasource) => void
}) {
  const saved = useAppStore((state) => state.grafanaSettings)
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const [token, setToken] = React.useState("")
  const [mode, setMode] = React.useState<TransportMode>("proxy")
  const [state, setState] = React.useState<{ status: "idle" | "loading" | "done"; items: GrafanaDatasource[]; error: string | null }>({
    status: "idle",
    items: [],
    error: null,
  })
  const label = type === "loki" ? "Loki" : "Prometheus"

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    // Pre-fill from the current data source proxy URL, else the Grafana connection.
    const fromCurrent = currentUrl && PROXY_PATH.test(currentUrl.trim()) ? currentUrl.trim().replace(PROXY_PATH, "") : ""
    const prefill = url || fromCurrent || saved.baseUrl
    setUrl(prefill)
    if (!token && grafanaKey(prefill) === grafanaKey(saved.baseUrl)) setToken(saved.token)
    setState({ status: "idle", items: [], error: null })
  }

  async function list(event?: React.FormEvent) {
    event?.preventDefault()
    if (!url.trim()) return
    setState({ status: "loading", items: [], error: null })
    try {
      const items = await listDatasources({ baseUrl: url.trim(), token, mode }, AbortSignal.timeout(15_000))
      setState({ status: "done", items: items.filter((item) => item.type === type), error: null })
    } catch (error) {
      setState({ status: "idle", items: [], error: problemText(error) })
    }
  }

  function pick(item: GrafanaDatasource) {
    onPick({
      baseUrl: datasourceProxyUrl(url.trim(), item.uid),
      authMode: token.trim() ? "bearer" : "none",
      token: token.trim(),
      mode,
      name: item.name,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <DatabaseIcon data-icon="inline-start" />
          Pick from Grafana
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pick a {label} data source</DialogTitle>
          <DialogDescription>
            Cardinal connects through Grafana's data source proxy with your Grafana token, so you don't need the backend's own credentials.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void list(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="grafana-pick-url">Grafana URL</FieldLabel>
              <Input
                id="grafana-pick-url"
                placeholder="https://grafana.example.com"
                autoComplete="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="grafana-pick-token">Service account token</FieldLabel>
              <Input
                id="grafana-pick-token"
                type="password"
                autoComplete="off"
                placeholder="Optional for anonymous Grafanas (glsa_…)"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <FieldDescription>Viewer role is enough. It becomes the connection's bearer token.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="grafana-pick-proxy">Route through the Cardinal proxy</FieldLabel>
                <FieldDescription>Grafana doesn't send CORS headers; leave this on unless your Grafana allows this origin.</FieldDescription>
              </FieldContent>
              <Switch id="grafana-pick-proxy" checked={mode === "proxy"} onCheckedChange={(checked) => setMode(checked ? "proxy" : "direct")} />
            </Field>
            <Button type="submit" variant="outline" className="self-start" disabled={!url.trim() || state.status === "loading"}>
              {state.status === "loading" ? <Spinner data-icon="inline-start" /> : <ListMagnifyingGlassIcon data-icon="inline-start" />}
              List data sources
            </Button>
          </FieldGroup>
        </form>

        {state.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Couldn't list data sources</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        {state.status === "done" ? (
          state.items.length ? (
            <ul aria-label={`${label} data sources`} className="-mx-1 flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {state.items.map((item) => (
                <li key={item.uid}>
                  <button
                    type="button"
                    onClick={() => pick(item)}
                    className="group/pick flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-well focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{item.name}</span>
                        {item.isDefault ? <Badge variant="outline">default</Badge> : null}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.uid}
                        {hostOf(item.url) ? ` · ${hostOf(item.url)}` : ""}
                      </span>
                    </span>
                    <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/pick:translate-x-0.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={DatabaseIcon} title={`No ${label} data sources`} description="This token can't see any, or the Grafana has none." />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
