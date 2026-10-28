import * as React from "react"
import { ClipboardTextIcon, LinkSimpleIcon, SquaresFourIcon, type Icon } from "@phosphor-icons/react"

import { useShellActions } from "@/app/shell/shell-actions"
import { ImportLogsDialog } from "@/features/logs/import-logs-dialog"
import { ImportSnapshotDialog } from "@/features/settings/import-snapshot-dialog"
import type { Signal } from "@/lib/core/signals"
import { cn } from "@/lib/utils"

// The one "how do you want to connect?" choice, the same wherever data is
// missing (Savings, a signal's overview, Settings): through Grafana, a URL, or
// a pasted query result without credentials.

const URL_COPY: Record<Signal, { title: string; text: string }> = {
  metrics: { title: "Prometheus URL", text: "Prometheus, Mimir or Grafana Cloud Metrics." },
  logs: { title: "Loki URL", text: "Loki or Grafana Cloud Logs." },
}

const ChoiceTile = React.forwardRef<
  HTMLButtonElement,
  { icon: Icon; title: string; text: string; primary?: boolean } & React.ComponentProps<"button">
>(function ChoiceTile({ icon: Icon, title, text, primary, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "group/choice flex min-w-0 flex-col items-start gap-1 rounded-xl border bg-background/60 p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
        primary ? "border-brand/40" : "border-well-border",
        className
      )}
      {...props}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Icon className={cn("size-4", primary ? "text-brand" : "text-muted-foreground")} />
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{text}</span>
    </button>
  )
})

export function ConnectChooser({ signal, onUrl, className }: { signal: Signal; onUrl: () => void; className?: string }) {
  const { openGrafanaConnect } = useShellActions()
  const paste = <ChoiceTile icon={ClipboardTextIcon} title="Paste a result" text="No credentials: run one query yourself." />
  return (
    <div className={cn("grid gap-2 sm:grid-cols-3", className)}>
      <ChoiceTile icon={SquaresFourIcon} title="Grafana" text="Finds your Prometheus and Loki data sources." primary onClick={openGrafanaConnect} />
      <ChoiceTile icon={LinkSimpleIcon} title={URL_COPY[signal].title} text={URL_COPY[signal].text} onClick={onUrl} />
      {signal === "logs" ? <ImportLogsDialog trigger={paste} /> : <ImportSnapshotDialog trigger={paste} />}
    </div>
  )
}
