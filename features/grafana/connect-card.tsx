import { PlugsConnectedIcon, SquaresFourIcon } from "@phosphor-icons/react"

import { useShellActions } from "@/app/shell/shell-actions"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Button } from "@/components/ui/button"

/** The Welcome state's Grafana shortcut: both signals from one Grafana, or keep connecting each by hand. */
export function ConnectGrafanaCard() {
  const { openGrafanaConnect } = useShellActions()
  return (
    <Frame>
      <FrameHeader icon={SquaresFourIcon} title="Grafana" meta="One step" />
      <FrameWell className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>Connect metrics and logs from its data sources, and optionally scan its dashboards. Or use the form: each signal can have its own backend.</p>
        <Button type="button" variant="outline" className="self-start" onClick={openGrafanaConnect}>
          <PlugsConnectedIcon data-icon="inline-start" />
          Connect Grafana
        </Button>
      </FrameWell>
    </Frame>
  )
}
