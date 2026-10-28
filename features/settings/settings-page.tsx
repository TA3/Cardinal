import * as React from "react"
import {
  BrowserIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClipboardTextIcon,
  CloudIcon,
  CurrencyDollarIcon,
  GearSixIcon,
  HardDrivesIcon,
  LightningIcon,
  LockKeyIcon,
  NetworkIcon,
  RobotIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { formatCost } from "@/components/cost-text"
import { InfoTip } from "@/components/info-tip"
import { Page, PageHeader } from "@/components/page"
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
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { DataSourceCard } from "@/features/settings/data-source-card"
import { LogsPriceField } from "@/features/settings/logs-connection-section"
import { AttributionSection } from "@/features/attribution/attribution-settings"
import { GrafanaSection } from "@/features/grafana/grafana-section"
import { RuleDestinationSection } from "@/features/rules/destination"
import { endAgentSession } from "@/hooks/use-agent-bridge"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/server-store"

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
    icon: ClipboardTextIcon,
    title: "No credentials",
    text: "Paste one query result under Metrics and upload dashboard or rule files under Grafana. They are read in this browser; nothing else is asked for.",
  },
  {
    icon: BrowserIcon,
    title: "Direct mode",
    text: "The browser calls your backend itself. Cardinal's servers never see the requests or the token.",
  },
  {
    icon: CloudIcon,
    title: "Proxy mode",
    text: "Only once you allow it: requests, with the token, pass through the Cardinal Worker to reach backends without CORS, such as Grafana Cloud. They are forwarded, never stored or logged.",
  },
  {
    icon: NetworkIcon,
    title: "Run it on your machine",
    text: "The cardinal binary or Docker image serves the app and its proxy from your machine, so backends on your network work and Cardinal's servers never see a request.",
  },
  {
    icon: RobotIcon,
    title: "Agent sessions",
    text: "Tool calls run in this tab, so the agent never gets your token. Their results (metric, job and label names, series counts and, once you allow it, label values) go to the agent and the LLM behind it.",
  },
]

function PrivacySection() {
  const share = useAppStore((state) => state.agentShareLabelValues)
  const setShare = useAppStore((state) => state.setAgentShareLabelValues)
  const proxyConsent = useAppStore((state) => state.proxyConsent)
  const setProxyConsent = useAppStore((state) => state.setProxyConsent)
  const selfHosted = useSelfHosted()
  return (
    <Card id="privacy" className="scroll-mt-32">
      <CardHeader>
        <SectionTitle icon={ShieldCheckIcon}>Privacy</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {selfHosted ? null : (
          <Field orientation="horizontal">
            <FieldLabel htmlFor="proxy-consent" className="gap-1">
              Allow Cardinal's proxy
              <InfoTip label="What does this change?">
                Grafana Cloud and other backends without CORS can only be reached from this page through Cardinal's servers, which forward
                each request with your token. Off: those requests are never sent. To keep everything on your machine, run Cardinal locally
                or upload exported files instead.
              </InfoTip>
            </FieldLabel>
            <Switch id="proxy-consent" checked={proxyConsent} onCheckedChange={setProxyConsent} />
          </Field>
        )}
        <Field orientation="horizontal">
          <FieldLabel htmlFor="share-label-values" className="gap-1">
            Share label values with agents
            <InfoTip label="What does this change?">
              Off: the agent's get_label_values tool is refused. It still sees label names and how many values each has.
            </InfoTip>
          </FieldLabel>
          <Switch id="share-label-values" checked={share} onCheckedChange={setShare} />
        </Field>
        <Collapsible>
          <CollapsibleTrigger className="group/facts inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <CaretRightIcon className="size-3 transition-transform group-data-[state=open]/facts:rotate-90 motion-reduce:transition-none" />
            What is stored where
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="grid gap-3 pt-3 sm:grid-cols-2">
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
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

/** Prices turn counts into cost; autopilot sits with them since both shape what Savings proposes. */
function PricingSection() {
  const autopilot = useAppStore((state) => state.autopilot)
  const setAutopilot = useAppStore((state) => state.setAutopilot)
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
    <Card id="pricing" className="scroll-mt-32">
      <CardHeader>
        <SectionTitle icon={CurrencyDollarIcon}>Pricing and autopilot</SectionTitle>
        <CardAction>
          <InfoTip label="What is pricing for?">Turns series counts and logs bytes into cost across Cardinal. Leave empty to hide costs.</InfoTip>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor="price" className="gap-1">
            Price per 1,000 active series per month
            <InfoTip label="About the preset">The preset is Grafana Cloud's Pro list price; volume tiers and contracts are cheaper, so use your own rate if you know it.</InfoTip>
          </FieldLabel>
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
          {price !== undefined && totalSeries ? (
            <FieldDescription>
              ~{formatCost((totalSeries / 1000) * price)}/mo for your {totalSeries.toLocaleString()} series
            </FieldDescription>
          ) : null}
        </Field>
        <LogsPriceField />
        <FieldSeparator />
        <Field id="autopilot" orientation="horizontal" className="scroll-mt-32">
          <FieldLabel htmlFor="autopilot-switch" className="flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              <LightningIcon className="size-4 text-muted-foreground" />
              Propose safe cuts automatically
            </span>
            <FieldDescription>Cuts rated safe go straight to Rules as proposals. Nothing is applied until you accept it.</FieldDescription>
          </FieldLabel>
          <Switch id="autopilot-switch" checked={autopilot} onCheckedChange={setAutopilot} />
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
    <Card id="reset" className="scroll-mt-32">
      <CardHeader>
        <SectionTitle icon={TrashIcon}>Reset</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Clears connections, tokens, snapshots, rules and pricing here, and ends any agent session.</p>
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

/** Sections under Advanced; a link to one of them opens it. */
const ADVANCED_IDS = ["attribution", "reset"]

function AdvancedSection({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // One tray: the header and the sections it opens share a frame, so they read as one group.
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-[1.25rem] border border-well-border bg-well [corner-shape:squircle]"
    >
      <CollapsibleTrigger className="group/advanced flex w-full items-center gap-2 rounded-[1.25rem] px-4 py-3 text-left outline-none transition-colors [corner-shape:squircle] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50">
        <GearSixIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Advanced</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">Attribution · Reset</span>
        <CaretDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/advanced:-rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-2 pb-2">
        <AttributionSection />
        <ResetSection />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>
}

export function SettingsPage() {
  const { hash, key } = useLocation()
  const target = hash.slice(1)
  const [advanced, setAdvanced] = React.useState(ADVANCED_IDS.includes(target))
  const [lastKey, setLastKey] = React.useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    if (ADVANCED_IDS.includes(target)) setAdvanced(true)
  }
  // Deep links (#pricing, #attribution, …): scroll once the section is rendered.
  React.useEffect(() => {
    if (!target) return
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" }))
    return () => cancelAnimationFrame(frame)
  }, [target, key, advanced])

  return (
    <Page className="max-w-4xl">
      <PageHeader title="Settings" description="Stored in this browser only." />
      <SectionHeading>Data sources</SectionHeading>
      <GrafanaSection />
      <DataSourceCard signal="metrics" />
      <DataSourceCard signal="logs" />
      <PrivacySection />
      <SectionHeading>Savings</SectionHeading>
      <PricingSection />
      <RuleDestinationSection />
      <AdvancedSection open={advanced} onOpenChange={setAdvanced} />
    </Page>
  )
}
