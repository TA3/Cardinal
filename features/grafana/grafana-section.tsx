import * as React from "react"
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ExportIcon,
  InfoIcon,
  PlugsConnectedIcon,
  PulseIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react"
import { useLocation } from "react-router"

import { useShellActions } from "@/app/shell/shell-actions"
import { InfoTip } from "@/components/info-tip"
import { LiveDot } from "@/components/motion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { hostOf } from "@/features/grafana/via-grafana"
import { privateHostHint, RouteField } from "@/features/relay/transport-mode-field"
import { routeLabel, withAutoMode } from "@/features/settings/auto-mode"
import { ProblemLine } from "@/features/settings/problem-line"
import { grafanaConnection } from "@/features/usage/grafana-store"
import { explainGrafanaError, GRAFANA_TIMEOUT_MS, GrafanaUsagePanel } from "@/features/usage/grafana-section"
import { testGrafana, type GrafanaCheck } from "@/lib/sources/grafana"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/relay-store"
import { cn } from "@/lib/utils"

const SERVICE_ACCOUNT_DOCS = "https://grafana.com/docs/grafana/latest/administration/service-accounts/"

function hostnameOf(url: string) {
  try {
    return url.trim() ? new URL(url.trim()).hostname : null
  } catch {
    return null
  }
}

/**
 * Settings → Grafana: the one home for the Grafana URL and token. Connect
 * Grafana picks data sources from it; the usage scan and dashboard export use
 * it too. Collapsed until used; the route is picked automatically.
 */
export function GrafanaSection() {
  const settings = useAppStore((state) => state.grafanaSettings)
  const update = useAppStore((state) => state.updateGrafanaSettings)
  const linked = useAppStore((state) => Boolean(state.grafanaLinks.metrics || state.grafanaLinks.logs))
  const { openGrafanaConnect, openGrafanaExport } = useShellActions()
  const { hash } = useLocation()
  const [testing, setTesting] = React.useState(false)
  const [check, setCheck] = React.useState<GrafanaCheck | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const connection = grafanaConnection(settings)
  const used = Boolean(connection) || linked
  const [open, setOpen] = React.useState(used || hash === "#grafana")
  const [advanced, setAdvanced] = React.useState(Boolean(settings.modeManual))
  const [lastHash, setLastHash] = React.useState(hash)
  if (hash !== lastHash) {
    setLastHash(hash)
    if (hash === "#grafana") setOpen(true)
  }

  const set = (patch: Partial<typeof settings>) => {
    update(patch)
    setCheck(null)
    setProblem(null)
  }
  const hostname = hostnameOf(settings.baseUrl)
  const selfHosted = useSelfHosted()
  const manual = settings.modeManual ? settings.mode : null
  const privateHint = manual ? privateHostHint(hostname, settings.mode, selfHosted) : null

  async function test() {
    if (!connection) return
    setTesting(true)
    setProblem(null)
    setCheck(null)
    try {
      const result = await withAutoMode(settings.baseUrl, manual, (mode) => testGrafana({ ...connection, mode }, AbortSignal.timeout(GRAFANA_TIMEOUT_MS)))
      if (result.ok) {
        if (result.mode !== settings.mode) update({ mode: result.mode })
        setCheck(result.value)
      } else setProblem(explainGrafanaError(result.error, result.mode))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card id="grafana" className="scroll-mt-32">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SquaresFourIcon className="size-4 text-muted-foreground" />
            Grafana
            {!used ? <span className="text-xs font-normal text-muted-foreground">optional</span> : null}
          </CardTitle>
          <CardAction className="flex items-center gap-2">
            {connection ? (
              <Badge variant="outline" className="border-brand/30 text-brand-ink">
                <LiveDot className="size-1.5" pulse={false} />
                {hostOf(connection.baseUrl)}
              </Badge>
            ) : (
              <Button type="button" size="sm" onClick={openGrafanaConnect}>
                <PlugsConnectedIcon data-icon="inline-start" />
                Connect Grafana
              </Button>
            )}
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={open ? "Hide Grafana settings" : "Show Grafana settings"}>
                <CaretDownIcon className={cn("transition-transform motion-reduce:transition-none", !open && "-rotate-90")} />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="pt-4">
            <FieldGroup className="gap-5">
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
                  <FieldLabel htmlFor="grafana-token" className="gap-1">
                    Service account token
                    <InfoTip label="Which role?">
                      Empty for anonymous access (e.g. play.grafana.org). Viewer reads data sources, dashboards and alert rules; exporting the
                      dashboard needs Editor.{" "}
                      <a href={SERVICE_ACCOUNT_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        Service accounts
                      </a>
                    </InfoTip>
                  </FieldLabel>
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
              <Field orientation="horizontal">
                <FieldLabel htmlFor="grafana-remember" className="font-normal" title="Off keeps the token in memory until you close the tab. Scans are always kept.">
                  Remember token on this device
                </FieldLabel>
                <Switch id="grafana-remember" checked={settings.rememberToken} onCheckedChange={(checked) => set({ rememberToken: checked })} />
              </Field>
              <Collapsible open={advanced} onOpenChange={setAdvanced}>
                <CollapsibleTrigger className="group/adv inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                  <CaretRightIcon className="size-3 transition-transform group-data-[state=open]/adv:rotate-90 motion-reduce:transition-none" />
                  Advanced
                  {manual ? <span className="font-normal">· {manual}</span> : null}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <RouteField
                    id="grafana-mode"
                    value={manual ?? "auto"}
                    picked={manual || !connection ? undefined : settings.mode}
                    onChange={(mode) => set(mode === "auto" ? { modeManual: false } : { mode, modeManual: true })}
                  />
                </CollapsibleContent>
              </Collapsible>
              {privateHint || (manual === "direct" && settings.baseUrl.trim()) ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <InfoIcon className="size-3.5 shrink-0" />
                  {privateHint ?? "Direct needs Grafana to allow this origin (CORS), e.g. in a reverse proxy."}
                </p>
              ) : null}
              {problem ? <ProblemLine problem={{ kind: "other", title: "Grafana couldn't be read", detail: problem }} /> : null}
              {check ? (
                <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
                  <CheckCircleIcon className="size-4" weight="fill" />
                  Grafana answered{routeLabel(settings.mode, selfHosted) ? ` ${routeLabel(settings.mode, selfHosted)}` : ""} in {check.latencyMs} ms
                  {check.anyDashboards ? "" : ", but this token sees no dashboards"}
                </p>
              ) : null}
              <Field orientation="horizontal" className="flex-wrap">
                <Button type="button" onClick={openGrafanaConnect}>
                  <PlugsConnectedIcon data-icon="inline-start" />
                  {connection ? "Pick data sources" : "Connect Grafana"}
                </Button>
                <Button type="button" variant="outline" disabled={!connection || testing} onClick={() => void test()}>
                  {testing ? <Spinner data-icon="inline-start" /> : <PulseIcon data-icon="inline-start" />}
                  Test
                </Button>
                <Button type="button" variant="outline" onClick={openGrafanaExport}>
                  <ExportIcon data-icon="inline-start" />
                  Export dashboard
                </Button>
              </Field>
              <FieldSeparator />
              <GrafanaUsagePanel />
            </FieldGroup>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
