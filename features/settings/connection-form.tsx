import * as React from "react"
import { CheckCircleIcon, InfoIcon, PlugsConnectedIcon, PulseIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { CodeBlock } from "@/components/code-block"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { diagnose, TEST_TIMEOUT_MS, type ConnectionProblem } from "@/features/settings/connection-check"
import { PickFromGrafana, type PickedDatasource } from "@/features/settings/pick-from-grafana"
import { privateHostHint, TransportModeField } from "@/features/relay/transport-mode-field"
import { ViaGrafana } from "@/features/grafana/via-grafana"
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
  const { baseUrl, authMode, instanceId, token, tenant, mode, rememberToken, topN } = draft
  return { baseUrl: baseUrl.trim(), authMode, instanceId, token, tenant, mode, rememberToken, topN }
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

function ProblemAlert({ problem, onFix }: { problem: ConnectionProblem; onFix: (patch: Partial<ConnectionSettings>) => void }) {
  return (
    <Alert
      data-problem={problem.kind}
      variant={problem.kind === "cors" || problem.kind === "private-proxy" ? "default" : "destructive"}
      role="alert"
    >
      <WarningCircleIcon />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{problem.detail}</span>
        {problem.snippet ? <CodeBlock code={problem.snippet} className="w-full" /> : null}
        {problem.fix ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onFix(problem.fix!.patch)}>
            {problem.fix.label}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

type Check = { signal: "metrics"; check: ConnectionCheck } | { signal: "logs"; check: LokiCheck }

function CheckResult({ result }: { result: Check }) {
  if (result.signal === "logs") {
    const { check } = result
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
          <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
          Reachable{check.version ? `: Loki ${check.version}` : ""}, {check.labelCount} stream label{check.labelCount === 1 ? "" : "s"}, answered in{" "}
          {check.latencyMs} ms.
        </p>
        {check.volumeApi ? null : (
          <Alert data-problem="no-volume">
            <InfoIcon />
            <AlertTitle>The volume API isn't available</AlertTitle>
            <AlertDescription>
              /loki/api/v1/index/volume didn't answer, so Cardinal can't measure bytes per service. It needs Loki 2.9 or newer with volume_enabled:
              true in limits_config. Stream and label counts still work.
            </AlertDescription>
          </Alert>
        )}
      </div>
    )
  }
  const { check } = result
  return (
    <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
      <CheckCircleIcon className="size-4" weight="fill" />
      Reachable{check.version ? `: Prometheus API ${check.version}` : ""}, answered in {check.latencyMs} ms.
    </p>
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

/** The connection form for a signal: metrics (Prometheus) by default, or logs (Loki). */
export function ConnectionForm({ signal = "metrics", onConnected }: { signal?: Signal; onConnected?: () => void }) {
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
  const set = (patch: Partial<ConnectionSettings>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setCheck(null)
  }

  const hostname = hostnameOf(draft.baseUrl)
  const cloud = isGrafanaCloudHost(draft.baseUrl)
  const selfHosted = useSelfHosted()
  const privateHint = privateHostHint(hostname, draft.mode, selfHosted)
  const pending = phase !== "idle"

  async function run(analyze: boolean) {
    const connection = currentConnection(draft)
    if (!connection) {
      setProblem({ kind: "config", title: `Enter the ${copy.urlLabel}`, detail: copy.urlHelp })
      return
    }
    const api = signal === "logs" ? "loki" : "prometheus"
    setProblem(null)
    setCheck(null)
    setPhase("testing")
    try {
      try {
        setCheck(
          signal === "logs"
            ? { signal, check: await testLokiConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS)) }
            : { signal, check: await testConnection(connection, AbortSignal.timeout(TEST_TIMEOUT_MS)) }
        )
      } catch (cause) {
        setProblem(await diagnose(cause, draft, api))
        return
      }
      if (!analyze) return

      setPhase("analyzing")
      if (signal === "logs") {
        try {
          const logsSettings = { ...useAppStore.getState().logsSettings, ...connectionFields(draft) }
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
          setProblem(await diagnose(cause, draft, api))
        } finally {
          setSnapshotProgress(null)
        }
        return
      }
      try {
        const snapshot = await fetchSnapshot(connection, draft.topN, { onProgress: log, onStep: setSnapshotProgress })
        // Drops breakdowns and impacts measured against the previous connection.
        switchConnection({ ...useAppStore.getState().settings, ...connectionFields(draft) }, snapshot)
        void queryClient.invalidateQueries()
        toast.success(`Connected: ${snapshot.totalSeries.toLocaleString()} active series`, {
          description:
            snapshot.method === "per-job"
              ? `Counted per job because of query limits${snapshot.skippedJobs?.length ? `; ${snapshot.skippedJobs.length} job(s) skipped` : ""}.`
              : undefined,
        })
        onConnected?.()
      } catch (cause) {
        setProblem(await diagnose(cause, draft))
      } finally {
        setSnapshotProgress(null)
      }
    } finally {
      setPhase("idle")
    }
  }

  function applyFix(patch: Partial<ConnectionSettings>) {
    set(patch)
    setProblem(null)
  }

  function applyPick(picked: PickedDatasource) {
    const { name, ...patch } = picked
    set({ ...patch, instanceId: "", tenant: "" })
    setProblem(null)
    toast.success(`Picked ${name}`, { description: "Test the connection, then save." })
  }

  const usesUser = draft.authMode === "basic" || draft.authMode === "grafana-cloud" || draft.authMode === "mimir"
  const usesToken = draft.authMode !== "none"

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void run(true)
      }}
    >
      <FieldGroup>
        <ViaGrafana signal={signal} />
        <Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FieldLabel htmlFor={id("base-url")}>{copy.urlLabel}</FieldLabel>
            <PickFromGrafana type={signal === "logs" ? "loki" : "prometheus"} currentUrl={draft.baseUrl} onPick={applyPick} />
          </div>
          <Input
            id={id("base-url")}
            placeholder={copy.placeholder}
            value={draft.baseUrl}
            autoComplete="url"
            onChange={(event) => {
              const baseUrl = event.target.value
              // Pasting a Grafana Cloud URL picks its auth mode and the proxy it needs.
              const becameCloud = isGrafanaCloudHost(baseUrl) && !isGrafanaCloudHost(draft.baseUrl)
              set(
                becameCloud
                  ? { baseUrl, mode: draft.mode === "direct" ? "proxy" : draft.mode, authMode: draft.authMode === "none" || draft.authMode === "basic" ? "grafana-cloud" : draft.authMode }
                  : { baseUrl }
              )
            }}
          />
          <FieldDescription>{copy.urlHelp}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel id={id("auth-mode-label")}>Authentication</FieldLabel>
          <div className="min-w-0">
            <SegmentedControl
              aria-label="Authentication"
              value={draft.authMode}
              onValueChange={(authMode) => set({ authMode })}
              options={authOptions(signal)}
            />
          </div>
          <FieldDescription>
            {draft.authMode === "none"
              ? copy.noneHelp
              : draft.authMode === "basic"
                ? copy.basicHelp
                : draft.authMode === "bearer"
                  ? "Sent as Authorization: Bearer <token>."
                  : draft.authMode === "grafana-cloud"
                    ? copy.cloudHelp
                    : "Sends the tenant as X-Scope-OrgID. With a username the password goes as Basic auth; with only a token, as Bearer."}
          </FieldDescription>
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
              <FieldLabel htmlFor={id("token")}>
                {draft.authMode === "basic"
                  ? "Password"
                  : draft.authMode === "grafana-cloud"
                    ? "Access policy token"
                    : draft.authMode === "mimir"
                      ? "Password or token"
                      : "Token"}
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

        {draft.authMode === "grafana-cloud" ? (
          <div className="rounded-2xl border border-well-border bg-well px-3.5 py-3 text-sm [corner-shape:squircle]">
            <p className="mb-2 text-muted-foreground">Scopes the access policy needs:</p>
            <ul className="flex flex-col gap-1">
              {(signal === "logs" ? GRAFANA_LOGS_SCOPES : GRAFANA_SCOPES).map((item) => (
                <li key={item.scope} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono text-xs">{item.scope}</code>
                  <span className="text-xs text-muted-foreground">{item.use}</span>
                </li>
              ))}
            </ul>
            {signal === "metrics" ? (
              <p className="mt-2 text-xs text-muted-foreground">Only metrics:read is required; the others enable Rules → Recommendations (Adaptive Metrics).</p>
            ) : null}
          </div>
        ) : null}

        <FieldSeparator />
        <TransportModeField id={id("mode")} value={draft.mode} onChange={(mode) => set({ mode })} />
        {usesToken ? (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={id("remember")}>Remember token on this device</FieldLabel>
              <FieldDescription>Off keeps the token in memory until you close the tab.</FieldDescription>
            </FieldContent>
            <Switch id={id("remember")} checked={draft.rememberToken} onCheckedChange={(checked) => set({ rememberToken: checked })} />
          </Field>
        ) : null}

        {cloud && draft.mode === "direct" ? (
          <Alert>
            <InfoIcon />
            <AlertDescription>Grafana Cloud does not allow browser requests; choose Proxy.</AlertDescription>
          </Alert>
        ) : privateHint ? (
          <Alert>
            <InfoIcon />
            <AlertDescription>{privateHint}</AlertDescription>
          </Alert>
        ) : draft.authMode === "mimir" && draft.mode === "direct" ? (
          <Alert>
            <InfoIcon />
            <AlertDescription>In direct mode the backend's CORS config must allow the X-Scope-OrgID header.</AlertDescription>
          </Alert>
        ) : null}

        {problem ? <ProblemAlert problem={problem} onFix={applyFix} /> : null}
        {check && !problem ? <CheckResult result={check} /> : null}
        {phase === "analyzing" ? <SnapshotProgressLine signal={signal} /> : null}

        <Field orientation="horizontal" className="flex-wrap">
          <Button type="button" variant="outline" disabled={pending || !draft.baseUrl.trim()} onClick={() => void run(false)}>
            {phase === "testing" ? <Spinner data-icon="inline-start" /> : <PulseIcon data-icon="inline-start" />}
            Test connection
          </Button>
          <Button type="submit" disabled={pending || !draft.baseUrl.trim()}>
            {phase === "analyzing" ? <Spinner data-icon="inline-start" /> : <PlugsConnectedIcon data-icon="inline-start" />}
            {phase === "analyzing" ? "Analyzing…" : "Save and analyze"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
