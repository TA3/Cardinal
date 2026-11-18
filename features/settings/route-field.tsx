import { SegmentedControl } from "@/components/segmented-control"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { hasProxyServer, type TransportMode } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"
import { useServerStore } from "@/lib/store/server-store"

/**
 * The hint for proxy mode on a page with no Cardinal server of the user's own
 * to go through (the hosted app has no proxy), or null.
 */
export function proxyModeHint(mode: TransportMode, selfHosted: boolean) {
  if (mode !== "proxy" || selfHosted || hasProxyServer()) return null
  return "This page has no proxy of its own: run Cardinal on your machine and set it under Settings → Your Cardinal server, or choose Direct."
}

/** One line on what a mode does. */
function useModeDescription(value: TransportMode | "auto", picked?: TransportMode) {
  const selfHosted = useServerStore((state) => state.server !== null)
  const proxyServer = useAppStore((state) => state.proxyServer)
  const ownServer = selfHosted || proxyServer !== ""
  const serverName = selfHosted ? "this server" : "your Cardinal server"
  if (value === "auto") {
    const now = picked ? ` Now: ${picked === "proxy" ? serverName : "direct"}.` : ""
    return ownServer
      ? `Through ${serverName}, or direct when it can't reach the backend.${now}`
      : `Direct from this browser: the backend must allow this origin (CORS). Set your Cardinal server for anything else.${now}`
  }
  if (value === "direct") return "The browser calls the backend, which must allow this origin (CORS)."
  return selfHosted
    ? "Through this Cardinal server, which reaches your network."
    : proxyServer
      ? `Through your Cardinal server at ${proxyServer}, which reaches your network.`
      : "Through your own Cardinal server: run it, then set it under Settings → Your Cardinal server."
}

function modeOptions(selfHosted: boolean) {
  return [
    { value: "direct" as const, label: "Direct" },
    { value: "proxy" as const, label: selfHosted ? "This server" : "Your server" },
  ]
}

/** Direct or proxy, for a metrics, logs or Grafana connection. */
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
  const selfHosted = useServerStore((state) => state.server !== null)
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
  const selfHosted = useServerStore((state) => state.server !== null)
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
