import * as React from "react"
import { CaretRightIcon, CheckCircleIcon, InfoIcon, PlugsConnectedIcon, PulseIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { InfoTip } from "@/components/info-tip"
import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { diagnose, TEST_TIMEOUT_MS, type ConnectionProblem } from "@/features/settings/connection-check"
import { PickFromGrafana, type PickedDatasource } from "@/features/settings/pick-from-grafana"
import { privateHostHint, RouteField } from "@/features/relay/transport-mode-field"
import { routeLabel, withAutoMode } from "@/features/settings/auto-mode"
import { ProblemLine } from "@/features/settings/problem-line"
import type { Signal } from "@/lib/core/signals"
import { fetchLogsSnapshot, testLokiConnection, type LokiCheck } from "@/lib/sources/loki"
import { fetchSnapshot, testConnection, type ConnectionCheck } from "@/lib/sources/prometheus"
import { isGrafanaCloudHost, type AuthMode } from "@/lib/sources/transport"
import { currentConnection, useAppStore, type ConnectionSettings } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/relay-store"

export function authOptions(signal: Signal): Array<{ value: AuthMode; label: string }> {
  return [
    { value: "none", label: "None" },
    { value: "basic", label: "Basic" },
    { value: "bearer", label: "Bearer" },
    { value: "grafana-cloud", label: "Grafana Cloud" },
    { value: "mimir", label: signal === "logs" ? "Tenant" : "Mimir tenant" },
  ]
}

/** Per-signal wording of the connection form. */
const COPY = {
  metrics: {
    urlLabel: "Prometheus URL",
    placeholder: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom",
    urlHelp: "Any Prometheus-compatible query API: Prometheus, Mimir, Thanos or Grafana Cloud.",
    noneHelp: "No credentials: an open Prometheus, or one protected by your network or a login in front of it.",
    basicHelp: "HTTP Basic auth, as set in Prometheus' web config or a reverse proxy.",
    cloudHelp: "Basic auth with the stack's instance ID and an access policy token (Stack → Prometheus → Details).",
  },
  logs: {
    urlLabel: "Loki URL",
    placeholder: "https://logs-prod-012.grafana.net",
    urlHelp: "The Loki root (it serves /loki/api/v1), Grafana Cloud Logs, or a Grafana data source proxy URL.",
    noneHelp: "No credentials: an open Loki, or one protected by your network, or an anonymous Grafana data source proxy.",
    basicHelp: "HTTP Basic auth, as set on a gateway or reverse proxy in front of Loki.",
    cloudHelp: "Basic auth with the stack's Loki user ID and an access policy token (Stack → Loki → Details).",
  },
} as const

/** Access policy scopes Cardinal uses on Grafana Cloud for logs. */
const GRAFANA_LOGS_SCOPES = [{ scope: "logs:read", use: "Snapshots, volume, patterns and the agent" }]

/** Access policy scopes Cardinal uses on Grafana Cloud. */
const GRAFANA_SCOPES = [
  { scope: "metrics:read", use: "Snapshots, drilldowns and the agent" },
  { scope: "adaptive-metrics-recommendations:read", use: "Adaptive Metrics recommendations" },
  { scope: "adaptive-metrics-rules:read", use: "Reading applied aggregation rules" },
  { scope: "adaptive-metrics-rules:write", use: "Applying aggregation rules from Cardinal" },
]

/** Fields the form owns; everything else in settings (pricing, …) is kept as saved. */
function connectionFields(draft: ConnectionSettings) {
  const { baseUrl, authMode, instanceId, token, tenant, mode, modeManual, rememberToken, topN } = draft
  return { baseUrl: baseUrl.trim(), authMode, instanceId, token, tenant, mode, modeManual, rememberToken, topN }
}

function hostnameOf(url: string) {
  try {
    return new URL(url.trim()).hostname
  } catch {
    return null
  }
}

function PasswordInput(props: React.ComponentProps<typeof Input>) {
  return <Input type="password" autoComplete="off" {...props} />
}

type Check = { signal: "metrics"; check: ConnectionCheck } | { signal: "logs"; check: LokiCheck }

function CheckResult({ result, route }: { result: Check; route: string | null }) {
  const check = result.check
  const what = result.signal === "logs" ? `Loki${check.version ? ` ${check.version}` : ""}` : `Prometheus API${check.version ? ` ${check.version}` : ""}`
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
        <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
        Reachable{route ? ` ${route}` : ""}: {what}, {check.latencyMs} ms
      </p>
      {result.signal === "logs" && !result.check.volumeApi ? (
        <p data-problem="no-volume" className="flex items-center gap-1 text-xs text-muted-foreground">
          No volume API: bytes per service won't show
          <InfoTip label="Why?">
            /loki/api/v1/index/volume didn't answer. It needs Loki 2.9 or newer with volume_enabled: true in limits_config. Stream and label
            counts still work.
          </InfoTip>
        </p>
      ) : null}
    </div>
  )
}

export function SnapshotProgressLine({ signal }: { signal: Signal }) {
  const progress = useAppStore((state) => (signal === "logs" ? state.logsSnapshotProgress : state.snapshotProgress))
  if (!progress) return null
  const value = progress.total > 0 ? (progress.done / progress.total) * 100 : null
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <span className="text-xs text-muted-foreground tabular-nums">
        {progress.phase}…{progress.total > 0 ? ` ${progress.done}/${progress.total}` : ""}
        {progress.phase === "Querying jobs" ? " (the full count was too large for one query)" : ""}
      </span>
      {value !== null ? <Progress value={value} className="h-1" /> : null}
    </div>
  )
}

/** The connection form for a signal: metrics (Prometheus) by default, or logs (Loki). URL and auth; the route is picked automatically. */
export function ConnectionForm({
  signal = "metrics",
  onConnected,
  onCancel,
}: {
  signal?: Signal
  onConnected?: () => void
  /** Shown as a Cancel button, for editing an existing connection. */
  onCancel?: () => void
}) {
  const saved = useAppStore((state) => (signal === "logs" ? state.logsSettings : state.settings))
  const switchConnection = useAppStore((state) => state.switchConnection)
  const switchLogsConnection = useAppStore((state) => state.switchLogsConnection)
  const setSnapshotProgress = useAppStore((state) => (signal === "logs" ? state.setLogsSnapshotProgress : state.setSnapshotProgress))
  const log = useAppStore((state) => state.log)
  const queryClient = useQueryClient()
  const copy = COPY[signal]
  // Metrics keeps its original ids; logs ids are prefixed so both forms can share a page.
  const id = (name: string) => (signal === "logs" ? `logs-${name}` : name)

  const [draft, setDraft] = React.useState<ConnectionSettings>(saved)
  // Follow connections changed elsewhere (Connect Grafana, Disconnect, another tab).
  const [lastSaved, setLastSaved] = React.useState(saved)
  if (saved !== lastSaved) {
    setLastSaved(saved)
    if (
      connectionFields(saved).baseUrl !== connectionFields(lastSaved).baseUrl ||
      saved.authMode !== lastSaved.authMode ||
      saved.token !== lastSaved.token ||
      saved.mode !== lastSaved.mode
    ) {
      setDraft(saved)
    }
  }
  const [phase, setPhase] = React.useState<"idle" | "testing" | "analyzing">("idle")
  const [problem, setProblem] = React.useState<ConnectionProblem | null>(null)
  const [check, setCheck] = React.useState<Check | null>(null)
  const [advanced, setAdvanced] = React.useState(Boolean(saved.modeManual))
  const set = (patch: Partial<ConnectionSettings>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setCheck(null)
  }

  const hostname = hostnameOf(draft.baseUrl)
  const cloud = isGrafanaCloudHost(draft.baseUrl)
  const selfHosted = useSelfHosted()
  const manual = draft.modeManual ? draft.mode : null
  const privateHint = manual ? privateHostHint(hostname, draft.mode, selfHosted) : null
  const pending = phase !== "idle"

  /** Tests the draft in the manual mode, or each auto mode in turn; returns the settings that worked. */
  async function reach(): Promise<ConnectionSettings | null> {
    if (!currentConnection(draft)) {
      setProblem({ kind: "config", title: `Enter the ${copy.urlLabel}`, detail: copy.urlHelp })
      return null
    }
    const api = signal === "logs" ? "loki" : "prometheus"
    const result = await withAutoMode(draft.baseUrl, manual, async (mode) => {
      const connection = currentConnection({ ...draft, mode })!
      return signal === "logs"
        ? ({ signal, check: await testLokiConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS)) } as const)
        : ({ signal, check: await testConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS)) } as const)
    })
    const settings = { ...draft, mode: result.mode }
    if (!result.ok) {
      setProblem(await diagnose(result.error, settings, api))
      return null
    }
    // Auto mode keeps what worked, so saving uses it.
    setDraft(settings)
    setCheck(result.value)
    return settings
  }

  async function run(analyze: boolean) {
    const api = signal === "logs" ? "loki" : "prometheus"
    setProblem(null)
    setCheck(null)
    setPhase("testing")
    try {
      const reached = await reach()
      if (!reached || !analyze) return
      const connection = currentConnection(reached)!

      setPhase("analyzing")
      if (signal === "logs") {
        try {
          const logsSettings = { ...useAppStore.getState().logsSettings, ...connectionFields(reached) }
          const snapshot = await fetchLogsSnapshot(connection, {
            range: logsSettings.range,
            groupLabel: logsSettings.groupLabel,
            onProgress: log,
            onStep: setSnapshotProgress,
          })
          switchLogsConnection(logsSettings, snapshot)
          void queryClient.invalidateQueries()
          toast.success(`Connected: ${snapshot.totals.streams.toLocaleString()} log streams`, {
            description: `Grouped by ${snapshot.groupLabel} over the last ${snapshot.range}.`,
          })
          onConnected?.()
        } catch (cause) {
          setProblem(await diagnose(cause, reached, api))
        } finally {
          setSnapshotProgress(null)
        }
        return
      }
      try {
        const snapshot = await fetchSnapshot(connection, reached.topN, { onProgress: log, onStep: setSnapshotProgress })
        // Drops breakdowns and impacts measured against the previous connection.
        switchConnection({ ...useAppStore.getState().settings, ...connectionFields(reached) }, snapshot)
        void queryClient.invalidateQueries()
        toast.success(`Connected: ${snapshot.totalSeries.toLocaleString()} active series`, {
          description:
            snapshot.method === "per-job"
              ? `Counted per job because of query limits${snapshot.skippedJobs?.length ? `; ${snapshot.skippedJobs.length} job(s) skipped` : ""}.`
              : undefined,
        })
        onConnected?.()
      } catch (cause) {
        setProblem(await diagnose(cause, reached))
      } finally {
        setSnapshotProgress(null)
      }
    } finally {
      setPhase("idle")
    }
  }

  function applyFix(patch: Partial<ConnectionSettings>) {
    set(patch.mode ? { ...patch, modeManual: true } : patch)
    if (patch.mode) setAdvanced(true)
    setProblem(null)
  }

  function applyPick(picked: PickedDatasource) {
    const { name, ...patch } = picked
    set({ ...patch, instanceId: "", tenant: "", modeManual: false })
    setProblem(null)
    toast.success(`Picked ${name}`, { description: "Test the connection, then save." })
  }

  const usesUser = draft.authMode === "basic" || draft.authMode === "grafana-cloud" || draft.authMode === "mimir"
  const usesToken = draft.authMode !== "none"
  const authHelp =
    draft.authMode === "none"
      ? copy.noneHelp
      : draft.authMode === "basic"
        ? copy.basicHelp
        : draft.authMode === "bearer"
          ? "Sent as Authorization: Bearer <token>."
          : draft.authMode === "grafana-cloud"
            ? copy.cloudHelp
            : "Sends the tenant as X-Scope-OrgID. With a username the password goes as Basic auth; with only a token, as Bearer."
  const hint =
    manual === "direct" && cloud
      ? "Grafana Cloud blocks browser requests: use Auto or Proxy."
      : privateHint
        ? privateHint
        : manual === "direct" && draft.authMode === "mimir"
          ? "Direct needs the backend's CORS to allow X-Scope-OrgID."
          : null

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void run(true)
      }}
    >
      <FieldGroup className="gap-5">
        <Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FieldLabel htmlFor={id("base-url")} className="gap-1">
              {copy.urlLabel}
              <InfoTip label="Which URL?">{copy.urlHelp}</InfoTip>
            </FieldLabel>
            <PickFromGrafana type={signal === "logs" ? "loki" : "prometheus"} currentUrl={draft.baseUrl} onPick={applyPick} />
          </div>
          <Input
            id={id("base-url")}
            placeholder={copy.placeholder}
            value={draft.baseUrl}
            autoComplete="url"
            onChange={(event) => {
              const baseUrl = event.target.value
              // Pasting a Grafana Cloud URL picks its auth mode.
              const becameCloud = isGrafanaCloudHost(baseUrl) && !isGrafanaCloudHost(draft.baseUrl)
              set(
                becameCloud
                  ? { baseUrl, authMode: draft.authMode === "none" || draft.authMode === "basic" ? "grafana-cloud" : draft.authMode }
                  : { baseUrl }
              )
            }}
          />
        </Field>

        <Field>
          <FieldLabel id={id("auth-mode-label")} className="gap-1">
            Authentication
            <InfoTip label="About this auth mode">{authHelp}</InfoTip>
          </FieldLabel>
          <div className="min-w-0">
            <SegmentedControl aria-label="Authentication" value={draft.authMode} onValueChange={(authMode) => set({ authMode })} options={authOptions(signal)} />
          </div>
        </Field>

        {draft.authMode === "mimir" ? (
          <Field>
            <FieldLabel htmlFor={id("tenant")}>Tenant ID (X-Scope-OrgID)</FieldLabel>
            <Input id={id("tenant")} placeholder="e.g. team-a" value={draft.tenant} onChange={(event) => set({ tenant: event.target.value })} />
          </Field>
        ) : null}

        {usesToken ? (
          <div className={usesUser ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
            {usesUser ? (
              <Field>
                <FieldLabel htmlFor={id("instance-id")}>{draft.authMode === "grafana-cloud" ? "Instance ID" : "Username"}</FieldLabel>
                <Input
                  id={id("instance-id")}
                  inputMode={draft.authMode === "grafana-cloud" ? "numeric" : undefined}
                  placeholder={draft.authMode === "grafana-cloud" ? "123456" : draft.authMode === "mimir" ? "Optional" : "Username"}
                  value={draft.instanceId}
                  onChange={(event) => set({ instanceId: event.target.value })}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={id("token")} className="gap-1">
                {draft.authMode === "basic"
                  ? "Password"
                  : draft.authMode === "grafana-cloud"
                    ? "Access policy token"
                    : draft.authMode === "mimir"
                      ? "Password or token"
                      : "Token"}
                {draft.authMode === "grafana-cloud" ? (
                  <InfoTip label="Scopes the token needs">
                    <ul className="flex flex-col gap-1">
                      {(signal === "logs" ? GRAFANA_LOGS_SCOPES : GRAFANA_SCOPES).map((item) => (
                        <li key={item.scope}>
                          <code className="font-mono">{item.scope}</code>: {item.use}
                        </li>
                      ))}
                    </ul>
                    {signal === "metrics" ? <p className="mt-1">Only metrics:read is required.</p> : null}
                  </InfoTip>
                ) : null}
              </FieldLabel>
              <PasswordInput
                id={id("token")}
                placeholder={draft.authMode === "grafana-cloud" ? "glc_…" : draft.authMode === "mimir" ? "Optional" : undefined}
                value={draft.token}
                onChange={(event) => set({ token: event.target.value })}
              />
            </Field>
          </div>
        ) : null}

        {usesToken ? (
          <Field orientation="horizontal">
            <FieldLabel htmlFor={id("remember")} className="font-normal" title="Off keeps the token in memory until you close the tab.">
              Remember token on this device
            </FieldLabel>
            <Switch id={id("remember")} checked={draft.rememberToken} onCheckedChange={(checked) => set({ rememberToken: checked })} />
          </Field>
        ) : null}

        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger className="group/adv inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <CaretRightIcon className="size-3 transition-transform group-data-[state=open]/adv:rotate-90 motion-reduce:transition-none" />
            Advanced
            {manual ? <span className="font-normal">· {manual === "proxy" && selfHosted ? "this server" : manual}</span> : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <RouteField
              id={id("mode")}
              value={manual ?? "auto"}
              picked={manual ? undefined : check || saved.baseUrl.trim() === draft.baseUrl.trim() ? draft.mode : undefined}
              onChange={(mode) => set(mode === "auto" ? { modeManual: false } : { mode, modeManual: true })}
            />
          </CollapsibleContent>
        </Collapsible>

        {hint ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="size-3.5 shrink-0" />
            {hint}
          </p>
        ) : null}

        {problem ? <ProblemLine problem={problem} onFix={applyFix} /> : null}
        {check && !problem ? <CheckResult result={check} route={routeLabel(draft.mode, selfHosted)} /> : null}
        {phase === "analyzing" ? <SnapshotProgressLine signal={signal} /> : null}

        <Field orientation="horizontal" className="flex-wrap">
          <Button type="submit" disabled={pending || !draft.baseUrl.trim()}>
            {phase === "analyzing" ? <Spinner data-icon="inline-start" /> : <PlugsConnectedIcon data-icon="inline-start" />}
            {phase === "analyzing" ? "Analyzing…" : "Connect"}
          </Button>
          <Button type="button" variant="outline" disabled={pending || !draft.baseUrl.trim()} onClick={() => void run(false)}>
            {phase === "testing" ? <Spinner data-icon="inline-start" /> : <PulseIcon data-icon="inline-start" />}
            Test
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </Field>
      </FieldGroup>
    </form>
  )
}
