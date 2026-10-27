import { SegmentedControl } from "@/components/segmented-control"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import type { TransportMode } from "@/lib/sources/transport"
import { useServerStore } from "@/lib/store/server-store"

/**
 * The hint for a private or local backend in the chosen mode, or null. The
 * hosted proxy can't reach such hosts; a self-hosted server's proxy can.
 */
export function privateHostHint(hostname: string | null, mode: TransportMode, selfHosted: boolean) {
  if (!hostname || !isPrivateHost(hostname) || mode !== "proxy" || selfHosted) return null
  return `${hostname} is private, so the hosted proxy can't reach it: choose Direct if it allows this origin, or run Cardinal on your machine.`
}

/** One line on what a mode does. */
function useModeDescription(value: TransportMode | "auto", picked?: TransportMode) {
  const selfHosted = useServerStore((state) => state.server !== null)
  const proxyName = selfHosted ? "this server" : "Cardinal's proxy"
  if (value === "auto") {
    const now = picked ? ` Now: ${picked === "proxy" ? proxyName : "direct"}.` : ""
    return `Direct when the backend allows it, else through ${proxyName}.${now}`
  }
  if (value === "direct") return "The browser calls the backend, which must allow this origin (CORS)."
  return selfHosted
    ? "Through this Cardinal server, which reaches your network."
    : "Through Cardinal's servers: public hosts only, asks first, nothing stored."
}

function modeOptions(selfHosted: boolean) {
  return [
    { value: "direct" as const, label: "Direct" },
    { value: "proxy" as const, label: selfHosted ? "This server" : "Proxy" },
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
