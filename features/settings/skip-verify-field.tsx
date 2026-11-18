import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/server-store"

// "Skip certificate check" for a backend (or Grafana) with a self-signed
// certificate. Browsers always check, so only the user's Cardinal server can
// skip it, for this connection's requests only: other backends, Grafana Cloud
// included, stay checked.

export function SkipVerifyField({
  id,
  baseUrl,
  checked,
  onCheckedChange,
}: {
  id: string
  baseUrl: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const selfHosted = useSelfHosted()
  const proxyServer = useAppStore((state) => state.proxyServer)
  const server = selfHosted || proxyServer !== ""
  // Nothing to skip over plain http, and nothing can skip it without a server; still shown while on, to turn it off.
  if (!checked && (!/^https:\/\//i.test(baseUrl.trim()) || !server)) return null
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Skip certificate check</FieldLabel>
        <FieldDescription>
          {server
            ? "For a self-signed certificate. Your Cardinal server then doesn't check who answers, so anyone in between could read the traffic, credentials included."
            : "Only your Cardinal server can skip it, and this page has none set: Settings → Your Cardinal server."}
        </FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}
