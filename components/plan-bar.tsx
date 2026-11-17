import { ArrowRightIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths } from "@/app/paths"
import { useBytesCost, useCost } from "@/components/cost-text"
import { Button } from "@/components/ui/button"
import { useLogRuleSavings, useRuleCounts, useSavings } from "@/hooks/use-cardinality"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { perDay } from "@/lib/core/logs/volume"
import { useAppStore } from "@/lib/store/app-store"

/**
 * Sticky at the bottom once something is in the plan: what the metrics and
 * logs cuts save, and the way to the config.
 */
export function PlanBar() {
  const counts = useRuleCounts()
  const savings = useSavings()
  const logs = useLogRuleSavings()
  const logsRange = useAppStore((state) => state.logsSnapshot?.range)
  const { format } = useCost()
  const bytes = useBytesCost()
  const rules = counts.active + logs.active
  if (rules === 0) return null
  const cost = counts.active ? format(savings.savedSeries) : null
  const logsPerDay = logsRange ? perDay(logs.savedBytes, logsRange) : 0
  const logsCost = logs.active && logsPerDay > 0 ? bytes.format(logsPerDay, "day") : null
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-2 flex justify-center">
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-frame-border bg-frame/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur">
        <span className="min-w-0 truncate text-sm tabular-nums">
          <span className="font-medium">Your plan</span>
          <span className="text-muted-foreground">
            {" "}
            · {rules} {rules === 1 ? "rule" : "rules"}
          </span>
          {counts.active ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium text-brand-ink">
                {savings.isEstimate ? "~" : ""}
                {formatDelta(-savings.savedSeries)} series
              </span>
              <span className="hidden text-muted-foreground sm:inline">
                {" "}
                ({savings.percent.toFixed(1)}%){cost ? ` · ${cost}` : ""}
              </span>
            </>
          ) : null}
          {logs.active && logsPerDay > 0 ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium text-brand-ink">
                {logs.isEstimate ? "~" : ""}−{formatBytes(logsPerDay)}/day
              </span>
              {logsCost ? <span className="hidden text-muted-foreground sm:inline"> · {logsCost}</span> : null}
            </>
          ) : null}
        </span>
        <Button asChild size="sm" className="shrink-0 rounded-full">
          <Link to={paths.rules}>
            Export config
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      </div>
    </div>
  )
}
