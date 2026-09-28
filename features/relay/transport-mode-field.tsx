import * as React from "react"
import { Link } from "react-router"

import { paths } from "@/app/paths"
import { SegmentedControl } from "@/components/segmented-control"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import type { TransportMode } from "@/lib/sources/transport"
import { useRelayStore } from "@/lib/store/relay-store"

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The hint for a private or local backend in the chosen mode, or null. The
 * hosted proxy can't reach such hosts; a self-hosted server's proxy and a
 * relay can.
 */
export function privateHostHint(hostname: string | null, mode: TransportMode, selfHosted: boolean) {
  if (!hostname || !isPrivateHost(hostname) || mode !== "proxy" || selfHosted) return null
  return `${hostname} is private, so the hosted proxy can't reach it: choose Relay, or Direct if it allows this origin.`
}

const MODE_NAMES: Record<TransportMode, string> = { direct: "Direct", proxy: "Proxy", relay: "Relay" }

/** One line on what a mode does. */
function useModeDescription(value: TransportMode | "auto", picked?: TransportMode): React.ReactNode {
  const selfHosted = useRelayStore((state) => state.server !== null)
  const relayUrl = useRelayStore((state) => state.relay.url.trim())
  if (value === "auto") {
    const now = picked ? ` Now: ${picked === "proxy" && selfHosted ? "this server" : MODE_NAMES[picked].toLowerCase()}.` : ""
    return `Direct when the backend allows it, else through ${selfHosted ? "this server" : "the Cardinal proxy"}.${now}`
  }
  if (value === "direct") return "The browser calls the backend, which must allow this origin (CORS)."
  if (value === "proxy") {
    return selfHosted ? "Through this Cardinal server, which reaches your network." : "Through the Cardinal Worker: public hosts only, nothing stored."
  }
  if (relayUrl) return `Through your relay at ${hostOf(relayUrl)}.`
  return (
    <>
      Through a Cardinal server on your network.{" "}
      <Link to={`${paths.settings}#relay`} className="underline underline-offset-2">
        Set up the relay
      </Link>
      .
    </>
  )
}

function modeOptions(selfHosted: boolean) {
  return [
    { value: "direct" as const, label: "Direct" },
    { value: "proxy" as const, label: selfHosted ? "This server" : "Proxy" },
    { value: "relay" as const, label: "Relay" },
  ]
}

/** Direct, proxy or relay, for a metrics, logs or Grafana connection. */
export function TransportModeField({
  id,
  value,
  onChange,
}: {
  id: string
  value: TransportMode
  onChange: (mode: TransportMode) => void
  /** Kept for callers; descriptions are always one line now. */
  compact?: boolean
}) {
  const selfHosted = useRelayStore((state) => state.server !== null)
  const description = useModeDescription(value)
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Route requests</FieldLabel>
      <div className="min-w-0">
        <SegmentedControl aria-label="Route requests" value={value} onValueChange={onChange} options={modeOptions(selfHosted)} />
      </div>
      <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
    </Field>
  )
}

/** Auto (the default: direct, else proxy), or a manual mode. `picked` is what auto chose last. */
export function RouteField({
  id,
  value,
  onChange,
  picked,
}: {
  id: string
  value: TransportMode | "auto"
  onChange: (mode: TransportMode | "auto") => void
  picked?: TransportMode
}) {
  const selfHosted = useRelayStore((state) => state.server !== null)
  const description = useModeDescription(value, picked)
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Route requests</FieldLabel>
      <div className="min-w-0">
        <SegmentedControl
          aria-label="Route requests"
          value={value}
          onValueChange={onChange}
          options={[{ value: "auto" as const, label: "Auto" }, ...modeOptions(selfHosted)]}
        />
      </div>
      <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
    </Field>
  )
}
