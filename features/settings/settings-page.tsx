import * as React from "react"
import {
  BrowserIcon,
  CloudIcon,
  CurrencyDollarIcon,
  HardDrivesIcon,
  LockKeyIcon,
  PaletteIcon,
  PlugsIcon,
  RobotIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { useTheme } from "next-themes"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { formatCost } from "@/components/cost-text"
import { LiveDot } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { SegmentedControl } from "@/components/segmented-control"
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
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { ConnectionForm } from "@/features/settings/connection-form"
import { LogsConnectionSection, LogsPriceField } from "@/features/settings/logs-connection-section"
import { AttributionSection } from "@/features/attribution/attribution-settings"
import { GrafanaSection } from "@/features/grafana/grafana-section"
import { endAgentSession } from "@/hooks/use-agent-bridge"
import { useAppStore } from "@/lib/store/app-store"

/** Grafana Cloud Pro list price for metrics, per 1,000 active series per month (first volume tier). */
const GRAFANA_CLOUD_PRICE = 6.5

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </CardTitle>
  )
}

function ConnectionSection() {
  const navigate = useNavigate()
  const hasSource = useAppStore((state) => Boolean(state.settings.baseUrl))
  return (
    <Card id="connection">
      <CardHeader>
        <SectionTitle icon={PlugsIcon}>Connection</SectionTitle>
        <CardDescription>Metrics source for snapshots, drilldowns and the agent. Test it, then save to take a snapshot.</CardDescription>
        {hasSource ? (
          <CardAction>
            <Badge variant="outline" className="border-brand/30 text-brand-ink">
              <LiveDot className="size-1.5" />
              Connected
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <ConnectionForm onConnected={() => navigate(paths.overview)} />
      </CardContent>
    </Card>
  )
}

const PRIVACY_FACTS = [
  {
    icon: HardDrivesIcon,
    title: "Stored in this browser",
    text: "Connection details, the snapshot, rules and preferences live in this browser's local storage. Nothing is saved on a Cardinal server.",
  },
  {
    icon: LockKeyIcon,
    title: "Your token",
    text: "Kept only in this browser: in local storage with “Remember token” on, otherwise in memory until the tab closes.",
  },
  {
    icon: BrowserIcon,
    title: "Direct mode",
    text: "The browser calls your backend itself. Cardinal's servers never see the requests or the token.",
  },
  {
    icon: CloudIcon,
    title: "Proxy mode",
    text: "Requests, with the token, pass through the Cardinal Worker to reach backends without CORS. They are forwarded, never stored or logged.",
  },
  {
    icon: RobotIcon,
    title: "Agent sessions",
    text: "Tool calls run in this tab, so the agent never gets your token. Their results (metric, job and label names, series counts and, if allowed, label values) go to the agent and the LLM behind it.",
  },
]

function PrivacySection() {
  const share = useAppStore((state) => state.agentShareLabelValues)
  const setShare = useAppStore((state) => state.setAgentShareLabelValues)
  return (
    <Card id="privacy">
      <CardHeader>
        <SectionTitle icon={ShieldCheckIcon}>Privacy</SectionTitle>
        <CardDescription>What is stored where, and what leaves this browser.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="grid gap-3 sm:grid-cols-2">
          {PRIVACY_FACTS.map((fact) => (
            <li key={fact.title} className="flex items-start gap-3 text-sm">
              <fact.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{fact.title}</span>
                <span className="text-muted-foreground">{fact.text}</span>
              </div>
            </li>
          ))}
        </ul>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="share-label-values">Share label values with agents</FieldLabel>
            <FieldDescription>
              Off: the agent's get_label_values tool is refused. It still sees label names and how many values each has.
            </FieldDescription>
          </FieldContent>
          <Switch id="share-label-values" checked={share} onCheckedChange={setShare} />
        </Field>
      </CardContent>
    </Card>
  )
}

function PricingSection() {
  const price = useAppStore((state) => state.settings.pricePer1kSeries)
  const totalSeries = useAppStore((state) => state.snapshot?.totalSeries)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [text, setText] = React.useState(price === undefined ? "" : String(price))

  // Follow changes made elsewhere (preset button, reset, another tab).
  const [lastPrice, setLastPrice] = React.useState(price)
  if (price !== lastPrice) {
    setLastPrice(price)
    // Keep what is being typed ("6." is 6) unless the price really changed.
    if (text.trim() === "" ? price !== undefined : Number(text) !== price) setText(price === undefined ? "" : String(price))
  }

  function commit(value: string) {
    setText(value)
    const trimmed = value.trim()
    if (!trimmed) {
      updateSettings({ pricePer1kSeries: undefined })
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed >= 0) updateSettings({ pricePer1kSeries: parsed })
  }

  const invalid = text.trim() !== "" && !(Number(text) >= 0)

  return (
    <Card id="pricing">
      <CardHeader>
        <SectionTitle icon={CurrencyDollarIcon}>Pricing</SectionTitle>
        <CardDescription>Turns series counts and logs bytes into cost on the overview, explore and rules pages. Leave empty to hide costs.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor="price">Price per 1,000 active series per month</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-44">
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="price"
                inputMode="decimal"
                placeholder="Not set"
                value={text}
                aria-invalid={invalid || undefined}
                onChange={(event) => commit(event.target.value)}
              />
            </InputGroup>
            <Button type="button" variant="outline" size="sm" onClick={() => commit(String(GRAFANA_CLOUD_PRICE))}>
              Grafana Cloud Pro ({formatCost(GRAFANA_CLOUD_PRICE)})
            </Button>
            {price !== undefined ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => commit("")}>
                Clear
              </Button>
            ) : null}
          </div>
          <FieldDescription>
            {price !== undefined && totalSeries
              ? `Your current ${totalSeries.toLocaleString()} series come to about ${formatCost((totalSeries / 1000) * price)} a month.`
              : "The Grafana Cloud preset is the Pro list price; volume tiers and contracts are cheaper, so use your own rate if you know it."}
          </FieldDescription>
        </Field>
        <LogsPriceField />
      </CardContent>
    </Card>
  )
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  return (
    <Card id="appearance">
      <CardHeader>
        <SectionTitle icon={PaletteIcon}>Appearance</SectionTitle>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Theme</FieldLabel>
            <FieldDescription>Also toggled with the D key.</FieldDescription>
          </FieldContent>
          <SegmentedControl
            aria-label="Theme"
            value={theme ?? "system"}
            onValueChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Field>
      </CardContent>
    </Card>
  )
}

function ResetSection() {
  const navigate = useNavigate()
  const resetAll = useAppStore((state) => state.resetAll)

  function reset() {
    void endAgentSession()
    resetAll()
    toast.success("Local data cleared")
    navigate(paths.overview)
  }

  return (
    <Card id="reset">
      <CardHeader>
        <SectionTitle icon={TrashIcon}>Reset</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Remove the connection, token, snapshot, rules and pricing stored in this browser, and end any agent session.
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="self-start sm:self-auto">
              <TrashIcon data-icon="inline-start" />
              Clear local data
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear everything?</AlertDialogTitle>
              <AlertDialogDescription>Your rules and connection details will be removed from this browser. This can't be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={reset}>
                Clear
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

export function SettingsPage() {
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Settings" description="Data sources and preferences. Everything here is stored in this browser only." />
      <GrafanaSection />
      <ConnectionSection />
      <LogsConnectionSection />
      <PrivacySection />
      <PricingSection />
      <AttributionSection />
      <AppearanceSection />
      <ResetSection />
    </Page>
  )
}
