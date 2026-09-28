import * as React from "react"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CloudIcon,
  DatabaseIcon,
  InfoIcon,
  ListMagnifyingGlassIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { takeNextPath } from "@/app/continue-after-connect"
import { EmptyState } from "@/components/empty-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { hostOf } from "@/features/grafana/via-grafana"
import { privateHostHint, TransportModeField } from "@/features/relay/transport-mode-field"
import { diagnose, TEST_TIMEOUT_MS } from "@/features/settings/connection-check"
import { SnapshotProgressLine } from "@/features/settings/connection-form"
import { startGrafanaScan } from "@/features/usage/grafana-store"
import { explainGrafanaError, GRAFANA_TIMEOUT_MS } from "@/features/usage/grafana-section"
import {
  activeLink,
  connectGrafana,
  detectGrafanaDatasources,
  type DatasourceCandidate,
  type GrafanaDetection,
  type SignalChoice,
  type SignalPlan,
} from "@/lib/core/grafana-connect"
import type { Signal } from "@/lib/core/signals"
import { listDatasources } from "@/lib/sources/grafana"
import { fetchLogsSnapshot, testLokiConnection } from "@/lib/sources/loki"
import { fetchSnapshot, testConnection } from "@/lib/sources/prometheus"
import { currentConnection, useAppStore, type ConnectionSettings } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/relay-store"

// Connect Grafana: one Grafana URL and token, then a Prometheus and a Loki data
// source (or neither) connected through Grafana's data source proxy, an
// optional dashboard scan, and Grafana Cloud's Adaptive APIs where the data
// sources reveal the stack's hosts. Every choice stays overridable per signal.

const SERVICE_ACCOUNT_DOCS = "https://grafana.com/docs/grafana/latest/administration/service-accounts/"
const SKIP = "__skip"

const COPY = {
  metrics: {
    title: "Metrics",
    type: "Prometheus",
    adaptive: "Adaptive Metrics",
    idLabel: "Instance ID",
    idNoun: "instance ID",
    scopes: "metrics:read, plus adaptive-metrics-recommendations:read and adaptive-metrics-rules:read/write",
  },
  logs: {
    title: "Logs",
    type: "Loki",
    adaptive: "Adaptive Logs",
    idLabel: "Loki user ID",
    idNoun: "Loki user ID",
    scopes: "logs:read, plus adaptive-logs:admin",
  },
} as const

interface ChoiceDraft {
  /** A data source uid, or null for "don't use Grafana". */
  uid: string | null
  direct: boolean
  instanceId: string
  token: string
}

type ApplyStatus =
  | { state: "testing" | "snapshot"; name: string }
  | { state: "done"; name: string; detail: string }
  | { state: "error"; name: string; title: string; detail: string }

function draftFor(signal: Signal, detection: GrafanaDetection, current: ConnectionSettings, link: ReturnType<typeof activeLink>): ChoiceDraft {
  const cloud = link?.via === "cloud"
  return {
    uid: detection[signal].preselected,
    direct: cloud,
    instanceId: cloud ? current.instanceId : "",
    token: cloud ? current.token : "",
  }
}

function toChoice(draft: ChoiceDraft): SignalChoice {
  if (!draft.uid) return { use: "skip" }
  return draft.direct ? { use: "cloud", uid: draft.uid, instanceId: draft.instanceId, token: draft.token } : { use: "grafana", uid: draft.uid }
}

function CandidateRow({ candidate, signal, current }: { candidate: DatasourceCandidate; signal: Signal; current: boolean }) {
  const id = `grafana-${signal}-${candidate.uid}`
  return (
    <label
      htmlFor={id}
      className="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-well has-data-checked:bg-well"
    >
      <RadioGroupItem id={id} value={candidate.uid} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{candidate.name}</span>
          {candidate.isDefault ? <Badge variant="outline">default</Badge> : null}
          {current ? (
            <Badge variant="outline" className="border-brand/30 text-brand-ink">
              in use
            </Badge>
          ) : null}
          {candidate.adaptiveBaseUrl ? (
            <Badge variant="outline">
              <CloudIcon data-icon="inline-start" />
              Grafana Cloud
            </Badge>
          ) : null}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {candidate.uid}
          {candidate.url ? ` · ${hostOf(candidate.url)}` : ""}
        </span>
        {candidate.note ? <span className="text-xs text-muted-foreground">{candidate.note}</span> : null}
      </span>
    </label>
  )
}

function SignalPicker({
  signal,
  detection,
  draft,
  onChange,
}: {
  signal: Signal
  detection: GrafanaDetection
  draft: ChoiceDraft
  onChange: (patch: Partial<ChoiceDraft>) => void
}) {
  const copy = COPY[signal]
  const detected = detection[signal]
  const currentUrl = useAppStore((state) => (signal === "logs" ? state.logsSettings.baseUrl : state.settings.baseUrl))
  const link = useAppStore((state) => activeLink(state.grafanaLinks[signal], currentUrl))
  const selected = detected.candidates.find((candidate) => candidate.uid === draft.uid)
  const adaptive = detection.adaptive[signal]
  const noun = copy.title.toLowerCase()

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 flex w-full flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {copy.title} <span className="font-normal text-muted-foreground">({copy.type})</span>
        </span>
        {detected.choiceNeeded ? (
          <span className="text-xs text-muted-foreground">
            {detected.candidates.length} {copy.type} data sources: pick one. Cardinal remembers it.
          </span>
        ) : null}
      </legend>
      {detected.candidates.length === 0 ? (
        <EmptyState
          compact
          icon={DatabaseIcon}
          title={`No ${copy.type} data sources`}
          description={`This token sees none, so ${noun} keep ${currentUrl.trim() ? `their current connection (${hostOf(currentUrl)})` : "no connection"}.`}
        />
      ) : (
        <RadioGroup
          aria-label={`${copy.title} data source`}
          value={draft.uid ?? SKIP}
          onValueChange={(value) => onChange({ uid: value === SKIP ? null : value, ...(value === SKIP ? { direct: false } : {}) })}
          className="-mx-1 gap-0.5"
        >
          {detected.candidates.map((candidate) => (
            <CandidateRow key={candidate.uid} candidate={candidate} signal={signal} current={link?.uid === candidate.uid && link.grafanaUrl === detection.grafanaUrl} />
          ))}
          <label
            htmlFor={`grafana-${signal}-skip`}
            className="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-well has-data-checked:bg-well"
          >
            <RadioGroupItem id={`grafana-${signal}-skip`} value={SKIP} className="mt-0.5" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Don't use Grafana for {noun}</span>
              <span className="text-xs text-muted-foreground">
                {currentUrl.trim()
                  ? `Keep the current connection${link ? ` (via Grafana: ${link.name})` : ` (${hostOf(currentUrl)})`}.`
                  : `${copy.title} stay unconnected; connect them by hand any time.`}
              </span>
            </span>
          </label>
        </RadioGroup>
      )}

      {selected?.adaptiveBaseUrl ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-well-border bg-well px-3.5 py-3 [corner-shape:squircle]">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`grafana-${signal}-direct`}>
                <CloudIcon className="size-4 text-brand-ink" />
                Use {copy.adaptive}: connect directly
              </FieldLabel>
              <FieldDescription>
                This is Grafana Cloud. {copy.adaptive} lives on {hostOf(selected.adaptiveBaseUrl)}, which Grafana's data source proxy can't
                reach. Connect {noun} straight to it with the stack's {copy.idNoun} and an access policy token ({copy.scopes})
                instead of the Grafana token.
              </FieldDescription>
            </FieldContent>
            <Switch id={`grafana-${signal}-direct`} checked={draft.direct} onCheckedChange={(direct) => onChange({ direct })} />
          </Field>
          {draft.direct ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`grafana-${signal}-instance`}>{copy.idLabel}</FieldLabel>
                <Input
                  id={`grafana-${signal}-instance`}
                  inputMode="numeric"
                  placeholder="123456"
                  value={draft.instanceId}
                  onChange={(event) => onChange({ instanceId: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`grafana-${signal}-cloud-token`}>Access policy token</FieldLabel>
                <Input
                  id={`grafana-${signal}-cloud-token`}
                  type="password"
                  autoComplete="off"
                  placeholder="glc_…"
                  value={draft.token}
                  onChange={(event) => onChange({ token: event.target.value })}
                />
              </Field>
              <FieldDescription className="sm:col-span-2">
                Both are on grafana.com: your stack → {copy.type} → Details. Leave this off to read {noun} through Grafana with the Grafana token.
              </FieldDescription>
            </div>
          ) : null}
        </div>
      ) : draft.uid && adaptive.kind === "hidden" ? (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          This is a Grafana Cloud stack, but this token can't see the data source's backend URL. For {copy.adaptive}, connect {noun} by hand
          with the stack's {copy.type} URL ({signal === "logs" ? "https://logs-prod-….grafana.net" : "https://prometheus-….grafana.net/api/prom"}, from
          grafana.com → your stack → {copy.type} → Details) and an access policy token.
        </p>
      ) : null}
    </fieldset>
  )
}

function ApplyLine({ signal, status }: { signal: Signal; status: ApplyStatus }) {
  const title = COPY[signal].title
  if (status.state === "error") {
    return (
      <Alert variant="destructive" role="alert">
        <WarningCircleIcon />
        <AlertTitle>
          {title} ({status.name}): {status.title}
        </AlertTitle>
        <AlertDescription>{status.detail}</AlertDescription>
      </Alert>
    )
  }
  if (status.state === "done") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
        <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
        {title}: {status.detail}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" />
        {title}: {status.state === "testing" ? `testing ${status.name}…` : `taking a snapshot of ${status.name}…`}
      </p>
      {status.state === "snapshot" ? <SnapshotProgressLine signal={signal} /> : null}
    </div>
  )
}

function ConnectFlow({ onDone }: { onDone: () => void }) {
  const saved = useAppStore((state) => state.grafanaSettings)
  const updateGrafanaSettings = useAppStore((state) => state.updateGrafanaSettings)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [url, setUrl] = React.useState(saved.baseUrl)
  const [token, setToken] = React.useState(saved.token)
  const [mode, setMode] = React.useState(saved.mode)
  const selfHosted = useSelfHosted()
  const [remember, setRemember] = React.useState(saved.rememberToken)
  const [listing, setListing] = React.useState<{ status: "idle" | "loading" | "done"; latencyMs?: number; error?: string }>({ status: "idle" })
  const [detection, setDetection] = React.useState<GrafanaDetection | null>(null)
  const [drafts, setDrafts] = React.useState<Record<Signal, ChoiceDraft> | null>(null)
  const [scan, setScan] = React.useState(true)
  const [applying, setApplying] = React.useState(false)
  const [statuses, setStatuses] = React.useState<Partial<Record<Signal, ApplyStatus>>>({})
  const [problems, setProblems] = React.useState<string[]>([])

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value)
    setDetection(null)
    setDrafts(null)
    setListing({ status: "idle" })
  }

  async function list(event?: React.FormEvent) {
    event?.preventDefault()
    if (!url.trim()) return
    setListing({ status: "loading" })
    setProblems([])
    setStatuses({})
    const started = performance.now()
    try {
      const datasources = await listDatasources({ baseUrl: url.trim(), token, mode }, AbortSignal.timeout(GRAFANA_TIMEOUT_MS))
      const state = useAppStore.getState()
      const sameGrafana = url.trim().replace(/\/+$/, "") === state.grafanaSettings.baseUrl.trim().replace(/\/+$/, "")
      const next = detectGrafanaDatasources({ grafanaUrl: url, token, datasources, remembered: sameGrafana ? state.grafanaSettings.choices : {} })
      setDetection(next)
      setDrafts({
        metrics: draftFor("metrics", next, state.settings, activeLink(state.grafanaLinks.metrics, state.settings.baseUrl)),
        logs: draftFor("logs", next, state.logsSettings, activeLink(state.grafanaLinks.logs, state.logsSettings.baseUrl)),
      })
      setListing({ status: "done", latencyMs: Math.round(performance.now() - started) })
    } catch (error) {
      let text = explainGrafanaError(error, mode)
      if (/HTTP 403/.test(text) && token.trim()) {
        text += " Listing data sources needs the datasources:read permission; if the Viewer role lacks it on your Grafana, grant the Data sources Reader role or use an Editor token."
      }
      setListing({ status: "idle", error: text })
    }
  }

  // Re-running the flow starts from the saved Grafana.
  const listRef = React.useRef(list)
  React.useEffect(() => {
    listRef.current = list
  })
  React.useEffect(() => {
    if (saved.baseUrl.trim()) void listRef.current()
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function applySignal(plan: SignalPlan) {
    const signal = plan.signal
    const state = useAppStore.getState()
    const name = plan.link.name
    const settings = signal === "logs" ? { ...state.logsSettings, ...plan.connection } : { ...state.settings, ...plan.connection }
    const connection = currentConnection(settings)!
    const setProgress = signal === "logs" ? state.setLogsSnapshotProgress : state.setSnapshotProgress
    const status = (next: ApplyStatus) => setStatuses((current) => ({ ...current, [signal]: next }))
    status({ state: "testing", name })
    try {
      if (signal === "logs") await testLokiConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS))
      else await testConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS))
      status({ state: "snapshot", name })
      if (signal === "logs") {
        const logsSettings = { ...useAppStore.getState().logsSettings, ...plan.connection }
        const snapshot = await fetchLogsSnapshot(connection, {
          range: logsSettings.range,
          groupLabel: logsSettings.groupLabel,
          onProgress: state.log,
          onStep: setProgress,
        })
        useAppStore.getState().switchLogsConnection(logsSettings, snapshot)
        status({ state: "done", name, detail: `${snapshot.totals.streams.toLocaleString()} log streams, grouped by ${snapshot.groupLabel}.` })
      } else {
        const metricsSettings = { ...useAppStore.getState().settings, ...plan.connection }
        const snapshot = await fetchSnapshot(connection, metricsSettings.topN, { onProgress: state.log, onStep: setProgress })
        useAppStore.getState().switchConnection(metricsSettings, snapshot)
        status({ state: "done", name, detail: `${snapshot.totalSeries.toLocaleString()} active series.` })
      }
      useAppStore.getState().setGrafanaLinks({ [signal]: plan.link })
      return true
    } catch (error) {
      const problem = await diagnose(error, settings, signal === "logs" ? "loki" : "prometheus")
      status({ state: "error", name, title: problem.title, detail: problem.detail })
      return false
    } finally {
      setProgress(null)
    }
  }

  async function apply() {
    if (!detection || !drafts) return
    const plan = connectGrafana(detection, {
      token,
      mode,
      rememberToken: remember,
      scan,
      choices: { metrics: toChoice(drafts.metrics), logs: toChoice(drafts.logs) },
    })
    setProblems(plan.problems)
    if (plan.problems.length) return
    setApplying(true)
    setStatuses({})
    updateGrafanaSettings({
      baseUrl: detection.grafanaUrl,
      token: token.trim(),
      mode,
      rememberToken: remember,
      choices: { ...(url.trim() === saved.baseUrl.trim() ? saved.choices : {}), ...plan.remember },
    })
    try {
      const results = await Promise.all(plan.signals.map(applySignal))
      if (plan.signals.length) void queryClient.invalidateQueries()
      if (plan.scan) {
        void startGrafanaScan().then(
          (index) =>
            toast.success(`Scanned ${index.stats.dashboards.toLocaleString()} dashboards`, {
              description: `${index.stats.metrics.toLocaleString()} metrics referenced in ${index.stats.panels.toLocaleString()} panels.`,
            }),
          (error: unknown) => {
            if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("The dashboard scan failed", { description: explainGrafanaError(error, mode) })
          }
        )
      }
      if (results.every(Boolean)) {
        const connected = plan.signals.map((item) => COPY[item.signal].title.toLowerCase())
        toast.success(`Connected Grafana ${hostOf(detection.grafanaUrl)}`, {
          description: [
            connected.length ? `${connected.join(" and ")} via Grafana` : "",
            plan.skipped.length ? `${plan.skipped.join(" and ")} unchanged` : "",
            plan.scan ? "scanning dashboards in the background (Settings → Grafana)" : "",
          ]
            .filter(Boolean)
            .join("; ")
            .replace(/^./, (char) => char.toUpperCase()),
        })
        const next = plan.signals.map((item) => takeNextPath(item.signal)).find(Boolean)
        onDone()
        if (next && next !== `${window.location.pathname}${window.location.search}`) navigate(next)
      }
    } finally {
      setApplying(false)
    }
  }

  const detected = detection && drafts
  const privateHint = privateHostHint(
    (() => {
      try {
        return new URL(url.trim()).hostname
      } catch {
        return null
      }
    })(),
    mode,
    selfHosted
  )

  return (
    <>
      <DialogHeader className="px-4 pt-4">
        <DialogTitle>Connect Grafana</DialogTitle>
        <DialogDescription>
          Pick a Prometheus and a Loki data source from one Grafana, in one step. Each signal can also keep its own connection: nothing here is
          required.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <form onSubmit={(event) => void list(event)}>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="connect-grafana-url">Grafana URL</FieldLabel>
                <Input
                  id="connect-grafana-url"
                  placeholder="https://grafana.example.com"
                  autoComplete="url"
                  value={url}
                  onChange={(event) => edit(setUrl)(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connect-grafana-token">Service account token</FieldLabel>
                <Input
                  id="connect-grafana-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Optional (glsa_…)"
                  value={token}
                  onChange={(event) => edit(setToken)(event.target.value)}
                />
              </Field>
            </div>
            <FieldDescription>
              Leave the token empty for a Grafana with anonymous access, like{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => edit(setUrl)("https://play.grafana.org")}>
                play.grafana.org
              </button>
              . Otherwise a service account with the <strong className="font-medium text-foreground">Viewer</strong> role is enough to list
              data sources, query them and scan dashboards; creating the Cardinal dashboard in Grafana needs Editor.{" "}
              <a href={SERVICE_ACCOUNT_DOCS} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                Service accounts
                <ArrowSquareOutIcon className="size-3" />
              </a>
            </FieldDescription>
            <div className="grid gap-3 sm:grid-cols-2">
              <TransportModeField id="connect-grafana-mode" value={mode} onChange={edit(setMode)} compact />
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="connect-grafana-remember">Remember token</FieldLabel>
                  <FieldDescription>Off keeps it in memory until the tab closes, like the other connections.</FieldDescription>
                </FieldContent>
                <Switch id="connect-grafana-remember" checked={remember} onCheckedChange={setRemember} />
              </Field>
            </div>
            {privateHint ? (
              <Alert>
                <InfoIcon />
                <AlertDescription>{privateHint}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant={detected ? "outline" : "default"} disabled={!url.trim() || listing.status === "loading"}>
                {listing.status === "loading" ? <Spinner data-icon="inline-start" /> : <ListMagnifyingGlassIcon data-icon="inline-start" />}
                {detected ? "List again" : "Test and list data sources"}
              </Button>
              {listing.status === "done" && detection ? (
                <span className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
                  <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
                  Grafana answered in {listing.latencyMs} ms{detection.anonymous ? " (anonymous)" : ""}
                  {detection.stack ? `, Grafana Cloud stack ${detection.stack.slug}` : ""}.
                </span>
              ) : null}
            </div>
            {listing.error ? (
              <Alert variant="destructive" role="alert">
                <WarningCircleIcon />
                <AlertTitle>Couldn't list data sources</AlertTitle>
                <AlertDescription>{listing.error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </form>

        {detected ? (
          <>
            <FieldSeparator />
            <div className="grid gap-5 md:grid-cols-2">
              {(["metrics", "logs"] as const).map((signal) => (
                <SignalPicker
                  key={signal}
                  signal={signal}
                  detection={detection}
                  draft={drafts[signal]}
                  onChange={(patch) => setDrafts((current) => (current ? { ...current, [signal]: { ...current[signal], ...patch } } : current))}
                />
              ))}
            </div>
            <FieldSeparator />
            <Field orientation="horizontal">
              <Checkbox id="connect-grafana-scan" checked={scan} onCheckedChange={(checked) => setScan(checked === true)} />
              <FieldContent>
                <FieldLabel htmlFor="connect-grafana-scan">Scan dashboards and alert rules now</FieldLabel>
                <FieldDescription>
                  Read-only. Shows which panels use a metric or log stream before you drop it. Runs in the background; progress is in Settings →
                  Grafana.
                </FieldDescription>
              </FieldContent>
            </Field>
          </>
        ) : null}

        {problems.length ? (
          <Alert variant="destructive" role="alert">
            <WarningCircleIcon />
            <AlertTitle>Almost there</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {(["metrics", "logs"] as const).map((signal) => {
          const status = statuses[signal]
          return status ? <ApplyLine key={signal} signal={signal} status={status} /> : null
        })}
      </div>
      <DialogFooter className="m-0 rounded-b-xl">
        <Button type="button" variant="outline" onClick={onDone}>
          {Object.values(statuses).some((status) => status?.state === "error") ? "Close" : "Cancel"}
        </Button>
        <Button type="button" disabled={!detected || applying} onClick={() => void apply()}>
          {applying ? <Spinner data-icon="inline-start" /> : <PlugsConnectedIcon data-icon="inline-start" />}
          {applying ? "Connecting…" : "Apply"}
        </Button>
      </DialogFooter>
    </>
  )
}

/** The Connect Grafana dialog; mounted once in the shell and opened through useShellActions().openGrafanaConnect. */
export function ConnectGrafanaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 p-0 sm:max-w-3xl">
        {open ? <ConnectFlow onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
