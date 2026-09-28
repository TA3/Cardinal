import * as React from "react"
import { CheckIcon, SignpostIcon } from "@phosphor-icons/react"

import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { SegmentedControl } from "@/components/segmented-control"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useConnection, useLogsTarget, useMetricsTarget } from "@/hooks/use-cardinality"
import {
  BACKEND_NAMES,
  defaultMetricsDestination,
  LOGS_DESTINATIONS,
  logsDestinations,
  METRICS_DESTINATIONS,
  metricsDestinations,
  type MetricsDestination,
} from "@/lib/core/backend-profile"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// "Where should rules go?": asked once after connecting (preselected from
// the detected backend), changeable in Settings and on the Export card.

/** "Detected Prometheus 3.13.0", or null before detection finishes. */
export function DetectedBackend({ className }: { className?: string }) {
  const { profile } = useMetricsTarget()
  if (!profile) return null
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      Detected {BACKEND_NAMES[profile.kind]}
      {profile.version ? ` ${profile.version}` : ""}
    </span>
  )
}

/** The destination as a segmented control; changing it changes every export. */
export function DestinationControl({ stretch = false, size = "default" }: { stretch?: boolean; size?: "default" | "sm" }) {
  const { profile, destination, adaptive } = useMetricsTarget()
  const setDestination = useAppStore((state) => state.setMetricsDestination)
  const options = metricsDestinations(adaptive ? { kind: "grafana-cloud" } : profile)
  return (
    <SegmentedControl
      stretch={stretch}
      size={size}
      aria-label="Where rules go"
      value={destination}
      onValueChange={setDestination}
      options={options.map((value) => ({ value, label: METRICS_DESTINATIONS[value].label, title: METRICS_DESTINATIONS[value].hint }))}
    />
  )
}

/** The one-time setup step: shown while connected and no destination was picked. One click picks. */
export function RuleDestinationStep({ className }: { className?: string }) {
  const connection = useConnection()
  const { profile, adaptive, chosen } = useMetricsTarget()
  const setDestination = useAppStore((state) => state.setMetricsDestination)
  if (!connection || chosen || !profile) return null
  const effective = adaptive ? { kind: "grafana-cloud" as const } : profile
  const detected = defaultMetricsDestination(effective)
  const options = metricsDestinations(effective)

  return (
    <Frame className={className}>
      <FrameHeader icon={SignpostIcon} title="Where should rules go?" meta={<DetectedBackend className="hidden sm:inline" />} />
      <FrameWell className="grid gap-2 py-3 sm:grid-cols-2 lg:grid-cols-4">
        {options.map((value: MetricsDestination) => (
          <button
            key={value}
            type="button"
            onClick={() => setDestination(value)}
            className={cn(
              "flex min-w-0 flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
              value === detected ? "border-brand/40 bg-brand/5" : "border-well-border bg-background/40"
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {METRICS_DESTINATIONS[value].label}
              {value === detected ? (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-brand-ink">
                  <CheckIcon className="size-3" />
                  suggested
                </span>
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">{METRICS_DESTINATIONS[value].hint}</span>
          </button>
        ))}
      </FrameWell>
    </Frame>
  )
}

/** Where log rules go, as a segmented control; changing it changes the logs export. */
export function LogsDestinationControl({ stretch = false, size = "default" }: { stretch?: boolean; size?: "default" | "sm" }) {
  const { destination, available } = useLogsTarget()
  const setDestination = useAppStore((state) => state.setLogsDestination)
  return (
    <SegmentedControl
      stretch={stretch}
      size={size}
      aria-label="Where log rules go"
      value={destination}
      onValueChange={setDestination}
      options={logsDestinations(available).map((value) => ({ value, label: LOGS_DESTINATIONS[value].label, title: LOGS_DESTINATIONS[value].hint }))}
    />
  )
}

function DestinationRow({ label, hint, children }: { label: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </div>
  )
}

/** Settings: the same choice, any time, per connected signal. */
export function RuleDestinationSection() {
  const metrics = useConnection()
  const logs = useConnection("logs")
  const { destination } = useMetricsTarget()
  const { destination: logsDestination } = useLogsTarget()
  if (!metrics && !logs) return null
  return (
    <Card id="rule-destination" className="scroll-mt-32">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SignpostIcon className="size-4 text-muted-foreground" />
          Where rules go
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {metrics ? (
          <DestinationRow label="Metrics" hint={METRICS_DESTINATIONS[destination].hint}>
            <DestinationControl size="sm" />
          </DestinationRow>
        ) : null}
        {logs ? (
          <DestinationRow label="Logs" hint={LOGS_DESTINATIONS[logsDestination].hint}>
            <LogsDestinationControl size="sm" />
          </DestinationRow>
        ) : null}
      </CardContent>
    </Card>
  )
}
