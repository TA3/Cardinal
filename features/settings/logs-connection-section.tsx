import * as React from "react"

import { formatCost } from "@/components/cost-text"
import { InfoTip } from "@/components/info-tip"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { formatBytes, toGB } from "@/lib/core/bytes"
import { bytesPerDay } from "@/lib/core/logs/snapshot"
import { useAppStore } from "@/lib/store/app-store"

/**
 * Grafana Cloud Pro list prices for logs as of September 2026, per GB: $0.05
 * process + $0.40 write + $0.10 retain (30 days). Volume tiers and contracts
 * are cheaper, so the field stays editable.
 */
export const GRAFANA_CLOUD_LOGS_PRICE_PER_GB = 0.55

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
      <FieldLabel htmlFor="price-per-gb" className="gap-1">
        Price per GB of logs ingested
        <InfoTip label="About the preset">
          Grafana Cloud's list price as of September 2026: $0.05 process, $0.40 write and $0.10 retain (30 days) per GB. Tiers and contracts are
          cheaper. 1 GB = 1,024³ bytes.
        </InfoTip>
      </FieldLabel>
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
      {price !== undefined && perDay !== undefined ? (
        <FieldDescription>
          ~{formatCost(toGB(perDay) * price)}/day for your ~{formatBytes(perDay)}/day
        </FieldDescription>
      ) : null}
    </Field>
  )
}
