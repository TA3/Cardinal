import * as React from "react"
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { StatFrame } from "@/components/frame"
import { LiveDot } from "@/components/motion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { cancelGrafanaScan, grafanaConnection, startGrafanaScan, useGrafanaStore } from "@/features/usage/grafana-store"
import { useNow } from "@/features/usage/use-dashboard-usage"
import { formatAge, hostOf, type GrafanaUsageIndex } from "@/lib/core/grafana-usage"
import { CorsError, HttpError } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

export const GRAFANA_TIMEOUT_MS = 15_000

/** What went wrong with a Grafana request, in terms of what to change. */
export function explainGrafanaError(error: unknown, mode: "direct" | "proxy") {
  if (error instanceof CorsError) {
    return "The browser couldn't read Grafana directly: Grafana doesn't send CORS headers by default. Turn on the proxy for a public Grafana, or allow this origin in a reverse proxy in front of Grafana."
  }
  if (error instanceof HttpError && error.proxyFailure === "private") {
    return "The proxy can't reach private or local hosts. Turn the proxy off; the browser then calls Grafana itself, which needs CORS allowed for this origin."
  }
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return `Grafana refused the request (HTTP ${error.status}). Use a service account token (Viewer is enough), or check that anonymous access is on if you left the token empty.`
  }
  if (error instanceof HttpError && error.status === 404) {
    return "No Grafana API at this URL (HTTP 404). Use the Grafana root, e.g. https://grafana.example.com."
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `Grafana didn't answer within ${GRAFANA_TIMEOUT_MS / 1000} s${mode === "direct" ? "" : " through the proxy"}.`
  }
  return error instanceof Error ? error.message : String(error)
}

function ScanProgressLine() {
  const progress = useGrafanaStore((state) => state.progress)
  if (!progress) return null
  const value = progress.total > 0 ? (progress.done / progress.total) * 100 : null
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <span className="text-xs text-muted-foreground tabular-nums">
        {progress.phase}…{progress.total > 0 ? ` ${progress.done.toLocaleString()}/${progress.total.toLocaleString()}` : ""}
      </span>
      {value !== null ? <Progress value={value} className="h-1" /> : null}
    </div>
  )
}

function ScanStats({ index }: { index: GrafanaUsageIndex }) {
  const { stats } = index
  const [open, setOpen] = React.useState(false)
  const details = index.failures.length + index.problems.length
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatFrame label="Dashboards" value={stats.dashboards.toLocaleString()} hint={stats.libraryPanels ? `${stats.libraryPanels} library ${stats.libraryPanels === 1 ? "panel" : "panels"}` : undefined} />
        <StatFrame label="Panels" value={stats.panels.toLocaleString()} hint={`${stats.queries.toLocaleString()} PromQL queries`} />
        <StatFrame
          label="Metrics referenced"
          value={stats.metrics.toLocaleString()}
          hint={index.alertsError ? "alerts not read" : `${stats.alerts.toLocaleString()} alert rules`}
        />
        <StatFrame
          label="Parse failures"
          value={stats.parseFailures.toLocaleString()}
          hint={stats.skippedQueries ? `${stats.skippedQueries} non-Prometheus skipped` : undefined}
        />
      </div>
      {index.alertsError ? (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Grafana-managed alert rules couldn't be read: {index.alertsError}
        </p>
      ) : null}
      {details ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="self-start">
              <CaretDownIcon data-icon="inline-start" className={open ? "" : "-rotate-90"} />
              {index.failures.length ? `${index.failures.length} partly understood ${index.failures.length === 1 ? "query" : "queries"}` : ""}
              {index.failures.length && index.problems.length ? " · " : ""}
              {index.problems.length ? `${index.problems.length} unreadable` : ""}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto text-xs">
              {index.problems.map((problem, position) => (
                <li key={`p${position}`} className="flex flex-col gap-0.5">
                  <span className="font-medium">{problem.where}</span>
                  <span className="text-destructive">{problem.message}</span>
                </li>
              ))}
              {index.failures.map((failure, position) => (
                <li key={`f${position}`} className="flex flex-col gap-0.5">
                  <span className="font-medium">{failure.where}</span>
                  <code className="font-mono break-all text-muted-foreground">{failure.expr}</code>
                  <span className="text-muted-foreground">
                    {failure.error}. Metrics were still found with a token scan; label usage counts as unknown.
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

/** The dashboard and alert usage scan of the Grafana connection: scan, progress and stats (Settings → Grafana). */
export function GrafanaUsagePanel() {
  const settings = useAppStore((state) => state.grafanaSettings)
  const index = useGrafanaStore((state) => state.index)
  const scanning = useGrafanaStore((state) => state.progress !== null)
  const scanError = useGrafanaStore((state) => state.scanError)
  const [problem, setProblem] = React.useState<string | null>(null)
  const now = useNow()
  const connection = grafanaConnection(settings)

  async function scan() {
    setProblem(null)
    try {
      const result = await startGrafanaScan()
      toast.success(`Scanned ${result.stats.dashboards.toLocaleString()} dashboards`, {
        description: `${result.stats.metrics.toLocaleString()} metrics referenced in ${result.stats.panels.toLocaleString()} panels${
          result.alertsError ? "" : ` and ${result.stats.alerts.toLocaleString()} alert rules`
        }.`,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setProblem(explainGrafanaError(error, settings.mode))
    }
  }

  const scannedAgo = index ? formatAge(now - new Date(index.scannedAt).getTime()) : null

  return (
    <div className="flex flex-col gap-4" id="grafana-usage">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <SquaresFourIcon className="size-4 text-muted-foreground" />
            Dashboard and alert usage
            {index ? (
              <Badge variant="outline" className="border-brand/30 text-brand-ink">
                <LiveDot className="size-1.5" pulse={false} />
                Scanned {scannedAgo}
              </Badge>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground">
            Reads every dashboard and Grafana-managed alert rule, read-only, to show which panels use a metric and which labels they filter or group by.
          </p>
        </div>
        {scanning ? (
          <Button type="button" variant="outline" onClick={cancelGrafanaScan}>
            <XIcon data-icon="inline-start" />
            Cancel scan
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={!connection} onClick={() => void scan()}>
            {index ? <ArrowClockwiseIcon data-icon="inline-start" /> : <MagnifyingGlassIcon data-icon="inline-start" />}
            {index ? "Re-scan dashboards" : "Scan dashboards"}
          </Button>
        )}
      </div>
      {problem || scanError ? (
        <Alert variant="destructive" role="alert">
          <WarningCircleIcon />
          <AlertTitle>{scanError && !problem ? "The last scan failed" : "Grafana couldn't be read"}</AlertTitle>
          <AlertDescription>{problem ?? scanError}</AlertDescription>
        </Alert>
      ) : null}
      <ScanProgressLine />
      {index ? (
        <>
          <p className="text-xs text-muted-foreground">
            Last scan: {hostOf(index.baseUrl)}, {new Date(index.scannedAt).toLocaleString()} ({scannedAgo}). Kept in this browser until you re-scan.
          </p>
          <ScanStats index={index} />
        </>
      ) : null}
    </div>
  )
}
