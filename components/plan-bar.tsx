import { ArrowRightIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths } from "@/app/paths"
import { useCost } from "@/components/cost-text"
import { Button } from "@/components/ui/button"
import { useRuleCounts, useSavings } from "@/hooks/use-cardinality"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"

/** Sticky at the bottom once something is in the plan: what it saves and the way to the config. */
export function PlanBar() {
  const counts = useRuleCounts()
  const savings = useSavings()
  const { format } = useCost()
  if (counts.active === 0) return null
  const cost = format(savings.savedSeries)
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-2 flex justify-center">
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-frame-border bg-frame/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur">
        <span className="min-w-0 truncate text-sm tabular-nums">
          <span className="font-medium">Your plan</span>
          <span className="text-muted-foreground">
            {" "}
            · {counts.active} {counts.active === 1 ? "rule" : "rules"} ·{" "}
          </span>
          <span className="font-medium text-brand-ink">
            {savings.isEstimate ? "~" : ""}
            {formatDelta(-savings.savedSeries)} series
          </span>
          <span className="text-muted-foreground">
            {" "}
            ({savings.percent.toFixed(1)}%)
          </span>
          {cost ? (
            <span className="hidden text-muted-foreground sm:inline">
              {" "}
              · {cost}
            </span>
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
