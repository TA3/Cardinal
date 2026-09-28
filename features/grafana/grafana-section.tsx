import * as React from "react"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ExportIcon,
  InfoIcon,
  PlugsConnectedIcon,
  PulseIcon,
  SquaresFourIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"

import { useShellActions } from "@/app/shell/shell-actions"
import { LiveDot } from "@/components/motion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { hostOf, useGrafanaLink } from "@/features/grafana/via-grafana"
import { privateHostHint, TransportModeField } from "@/features/relay/transport-mode-field"
import { grafanaConnection } from "@/features/usage/grafana-store"
import { explainGrafanaError, GRAFANA_TIMEOUT_MS, GrafanaUsagePanel } from "@/features/usage/grafana-section"
import type { Signal } from "@/lib/core/signals"
import { testGrafana, type GrafanaCheck } from "@/lib/sources/grafana"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/relay-store"

const SERVICE_ACCOUNT_DOCS = "https://grafana.com/docs/grafana/latest/administration/service-accounts/"

function hostnameOf(url: string) {
  try {
    return url.trim() ? new URL(url.trim()).hostname : null
  } catch {
    return null
  }
}

/** One signal's source: via Grafana, manual, or none. */
function SignalSource({ signal }: { signal: Signal }) {
  const link = useGrafanaLink(signal)
  const baseUrl = useAppStore((state) => (signal === "logs" ? state.logsSettings.baseUrl : state.settings.baseUrl))
  const label = signal === "logs" ? "Logs" : "Metrics"
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <LiveDot className="size-1.5" pulse={false} />
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">
        {link ? (
          <>
            {link.via === "cloud" ? "Grafana Cloud, from " : "via Grafana: "}
            <span className="font-medium">{link.name}</span>
          </>
        ) : baseUrl.trim() ? (
          <>
            Own connection <span className="text-muted-foreground">({hostOf(baseUrl.trim())})</span>
          </>
        ) : (
          <span className="text-muted-foreground">Not connected</span>
        )}
      </span>
    </li>
  )
}

/**
 * Settings → Grafana: the one home for the Grafana URL and token. Connect
 * Grafana picks data sources from it; the usage scan and dashboard export use
 * it too. Per-signal connections below stay independent.
 */
export function GrafanaSection() {
  const settings = useAppStore((state) => state.grafanaSettings)
  const update = useAppStore((state) => state.updateGrafanaSettings)
  const { openGrafanaConnect, openGrafanaExport } = useShellActions()
  const [testing, setTesting] = React.useState(false)
  const [check, setCheck] = React.useState<GrafanaCheck | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)

  const set = (patch: Partial<typeof settings>) => {
    update(patch)
    setCheck(null)
    setProblem(null)
  }
  const hostname = hostnameOf(settings.baseUrl)
  const selfHosted = useSelfHosted()
  const privateHint = privateHostHint(hostname, settings.mode, selfHosted)
  const connection = grafanaConnection(settings)

  async function test() {
    if (!connection) return
    setTesting(true)
    setProblem(null)
    setCheck(null)
    try {
      setCheck(await testGrafana(connection, AbortSignal.timeout(GRAFANA_TIMEOUT_MS)))
    } catch (error) {
      setProblem(explainGrafanaError(error, settings.mode))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card id="grafana" className="scroll-mt-32">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SquaresFourIcon className="size-4 text-muted-foreground" />
          Grafana
        </CardTitle>
        <CardDescription>
          One Grafana connection for picking data sources, scanning dashboards and exporting the Cardinal dashboard. Optional: metrics and logs
          can each keep their own connection below.
        </CardDescription>
        {connection ? (
          <CardAction>
            <Badge variant="outline" className="border-brand/30 text-brand-ink">
              <LiveDot className="size-1.5" pulse={false} />
              {hostOf(connection.baseUrl)}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="grafana-url">Grafana URL</FieldLabel>
              <Input
                id="grafana-url"
                placeholder="https://grafana.example.com"
                autoComplete="url"
                value={settings.baseUrl}
                onChange={(event) => set({ baseUrl: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="grafana-token">Service account token</FieldLabel>
              <Input
                id="grafana-token"
                type="password"
                autoComplete="off"
                placeholder="Optional (glsa_…)"
                value={settings.token}
                onChange={(event) => set({ token: event.target.value })}
              />
            </Field>
          </div>
          <FieldDescription>
            Empty for anonymous access (e.g. play.grafana.org). Viewer is enough to read: data sources, dashboards and alert rules (the
            provisioning API needs Admin; Cardinal falls back to the ruler API). Creating the exported dashboard needs Editor.{" "}
            <a href={SERVICE_ACCOUNT_DOCS} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2">
              Service accounts
              <ArrowSquareOutIcon className="size-3" />
            </a>
          </FieldDescription>
          <FieldSeparator />
          <TransportModeField id="grafana-mode" value={settings.mode} onChange={(mode) => set({ mode })} />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="grafana-remember">Remember token on this device</FieldLabel>
              <FieldDescription>Off keeps the token in memory until you close the tab. Scans are always kept.</FieldDescription>
            </FieldContent>
            <Switch id="grafana-remember" checked={settings.rememberToken} onCheckedChange={(checked) => set({ rememberToken: checked })} />
          </Field>
          {privateHint ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>{privateHint}</AlertDescription>
            </Alert>
          ) : settings.mode === "direct" && settings.baseUrl.trim() ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>Grafana doesn't send CORS headers by default: direct mode needs this origin allowed, e.g. in a reverse proxy in front of it.</AlertDescription>
            </Alert>
          ) : null}
          {problem ? (
            <Alert variant="destructive" role="alert">
              <WarningCircleIcon />
              <AlertTitle>Grafana couldn't be read</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          {check ? (
            <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
              <CheckCircleIcon className="size-4" weight="fill" />
              Grafana answered in {check.latencyMs} ms{check.anyDashboards ? "" : ", but this token sees no dashboards"}.
            </p>
          ) : null}
          <Field orientation="horizontal" className="flex-wrap">
            <Button type="button" variant="outline" disabled={!connection || testing} onClick={() => void test()}>
              {testing ? <Spinner data-icon="inline-start" /> : <PulseIcon data-icon="inline-start" />}
              Test
            </Button>
            <Button type="button" onClick={openGrafanaConnect}>
              <PlugsConnectedIcon data-icon="inline-start" />
              {connection ? "Pick data sources" : "Connect Grafana"}
            </Button>
            <Button type="button" variant="outline" onClick={openGrafanaExport}>
              <ExportIcon data-icon="inline-start" />
              Export Grafana dashboard
            </Button>
          </Field>
          <ul className="flex flex-col gap-1.5" aria-label="Data sources">
            <SignalSource signal="metrics" />
            <SignalSource signal="logs" />
          </ul>
          <FieldSeparator />
          <GrafanaUsagePanel />
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
