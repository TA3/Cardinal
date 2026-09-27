import * as React from "react"
import { ScrollIcon } from "@phosphor-icons/react"
import { useLocation, useNavigate } from "react-router"

import { paths } from "@/app/paths"
import { formatCost } from "@/components/cost-text"
import { LiveDot } from "@/components/motion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { ConnectionForm } from "@/features/settings/connection-form"
import { formatBytes, toGB } from "@/lib/core/bytes"
import { bytesPerDay } from "@/lib/core/logs/snapshot"
import { useAppStore } from "@/lib/store/app-store"

/**
 * Grafana Cloud Pro list prices for logs as of September 2026, per GB: $0.05
 * process + $0.40 write + $0.10 retain (30 days). Volume tiers and contracts
 * are cheaper, so the field stays editable.
 */
export const GRAFANA_CLOUD_LOGS_PRICE_PER_GB = 0.55

/** Settings → "Logs (Loki)": the logs connection, separate from the metrics one. */
export function LogsConnectionSection() {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const hasSource = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  const ref = React.useRef<HTMLDivElement>(null)
  // The header pill links here under Logs.
  React.useEffect(() => {
    if (hash === "#logs-connection") ref.current?.scrollIntoView({ block: "start" })
  }, [hash])
  return (
    <Card id="logs-connection" ref={ref} className="scroll-mt-32">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollIcon className="size-4 text-muted-foreground" />
          Logs (Loki)
        </CardTitle>
        <CardDescription>Logs source for stream and volume snapshots. Grafana Cloud Logs, any Loki, or a Loki data source in Grafana.</CardDescription>
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
        <ConnectionForm signal="logs" onConnected={() => navigate(paths.logs)} />
      </CardContent>
    </Card>
  )
}

/** The logs price per GB ingested, for the Pricing section. */
export function LogsPriceField() {
  const price = useAppStore((state) => state.settings.pricePerGB)
  const perDay = useAppStore((state) => (state.logsSnapshot ? bytesPerDay(state.logsSnapshot) : undefined))
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [text, setText] = React.useState(price === undefined ? "" : String(price))

  const [lastPrice, setLastPrice] = React.useState(price)
  if (price !== lastPrice) {
    setLastPrice(price)
    if (text.trim() === "" ? price !== undefined : Number(text) !== price) setText(price === undefined ? "" : String(price))
  }

  function commit(value: string) {
    setText(value)
    const trimmed = value.trim()
    if (!trimmed) {
      updateSettings({ pricePerGB: undefined })
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed >= 0) updateSettings({ pricePerGB: parsed })
  }

  const invalid = text.trim() !== "" && !(Number(text) >= 0)

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor="price-per-gb">Price per GB of logs ingested</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-44">
          <InputGroupAddon>
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            id="price-per-gb"
            inputMode="decimal"
            placeholder="Not set"
            value={text}
            aria-invalid={invalid || undefined}
            onChange={(event) => commit(event.target.value)}
          />
        </InputGroup>
        <Button type="button" variant="outline" size="sm" onClick={() => commit(String(GRAFANA_CLOUD_LOGS_PRICE_PER_GB))}>
          Grafana Cloud Logs ({formatCost(GRAFANA_CLOUD_LOGS_PRICE_PER_GB)})
        </Button>
        {price !== undefined ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => commit("")}>
            Clear
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        {price !== undefined && perDay !== undefined
          ? `Your logs ingest about ${formatBytes(perDay)} a day, about ${formatCost(toGB(perDay) * price)} a day at this price (1 GB = 1,024³ bytes).`
          : "The preset is Grafana Cloud's list price as of September 2026: $0.05 process, $0.40 write and $0.10 retain (30 days) per GB. Check grafana.com/pricing; tiers and contracts are cheaper."}
      </FieldDescription>
    </Field>
  )
}
