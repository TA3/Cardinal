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
  return `${hostname} is a private or local host, which the hosted proxy can't reach. Choose Relay to go through a Cardinal server on your network, or Direct if the backend allows this origin (CORS).`
}

/** Direct, proxy or relay, for a metrics, logs or Grafana connection. */
export function TransportModeField({
  id,
  value,
  onChange,
  compact = false,
}: {
  id: string
  value: TransportMode
  onChange: (mode: TransportMode) => void
  /** Shorter descriptions, for dialogs. */
  compact?: boolean
}) {
  const selfHosted = useRelayStore((state) => state.server !== null)
  const relayUrl = useRelayStore((state) => state.relay.url.trim())

  const description =
    value === "direct" ? (
      "The browser calls the backend itself, so the backend must allow this origin (CORS)."
    ) : value === "proxy" ? (
      selfHosted ? (
        "Through this Cardinal server, which reaches hosts on its network, private and loopback included. Credentials pass through and are never stored."
      ) : compact ? (
        "Through the Cardinal Worker, for public backends without CORS. It can't reach private hosts."
      ) : (
        "Through the Cardinal Worker, for Grafana Cloud and public backends without CORS. Credentials pass through and are never stored. It can't reach private hosts."
      )
    ) : relayUrl ? (
      `Through your relay at ${hostOf(relayUrl)}, a Cardinal server that reaches hosts on its network. Credentials pass through and are never stored.`
    ) : (
      <>
        Through a Cardinal server on your network.{" "}
        <Link to={`${paths.settings}#relay`} className="underline underline-offset-2">
          Set up the relay
        </Link>{" "}
        first.
      </>
    )

  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Route requests</FieldLabel>
      <div className="min-w-0">
        <SegmentedControl
          aria-label="Route requests"
          value={value}
          onValueChange={onChange}
          options={[
            { value: "direct", label: "Direct" },
            { value: "proxy", label: selfHosted ? "This server" : "Proxy" },
            { value: "relay", label: "Relay" },
          ]}
        />
      </div>
      <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
    </Field>
  )
}
