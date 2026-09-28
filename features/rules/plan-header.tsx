import * as React from "react"
import { ChartLineDownIcon } from "@phosphor-icons/react"

import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { InfoTip } from "@/components/info-tip"
import { Progress } from "@/components/ui/progress"

/**
 * "Your plan": what the active rules save (the big number, its cost and
 * share), and the one thing to do with them, for metrics and logs alike.
 */
export function PlanHeader({
  saving,
  unit,
  estimate,
  cost,
  detail,
  percent,
  meta,
  actions,
  children,
}: {
  saving: React.ReactNode
  unit: React.ReactNode
  estimate: boolean
  cost?: React.ReactNode
  /** e.g. "3 rules · 4.2% of 15,898 series". */
  detail: React.ReactNode
  percent: number
  meta?: React.ReactNode
  actions: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Frame>
      <FrameHeader icon={ChartLineDownIcon} title="Saves" meta={meta} />
      <FrameWell className="flex flex-col gap-3 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2 text-3xl font-medium tracking-tight tabular-nums">
              <span className="flex items-baseline">
                {estimate ? "~" : ""}
                {saving}
              </span>
              <span className="text-sm font-normal text-muted-foreground">{unit}</span>
              {estimate ? (
                <InfoTip label="Why an estimate?" className="self-center">
                  Some rules are estimates or haven't been measured yet, so ~ marks the total.
                </InfoTip>
              ) : null}
              {cost ? <span className="text-base font-normal text-muted-foreground">{cost}</span> : null}
            </span>
            <span className="text-sm text-muted-foreground tabular-nums">{detail}</span>
          </div>
          {actions}
        </div>
        <Progress value={percent} className="h-1" />
        {children}
      </FrameWell>
    </Frame>
  )
}
