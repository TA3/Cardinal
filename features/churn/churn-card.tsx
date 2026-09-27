import * as React from "react"
import { RepeatIcon } from "@phosphor-icons/react"

import { metricPath, paths } from "@/app/paths"
import { Frame, FrameHeader, FrameLink, FrameWell } from "@/components/frame"
import { ListRow } from "@/components/list-rows"
import { AnimatedNumber, SwapText } from "@/components/motion"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatChurnPercent, formatRatio } from "@/features/churn/format"
import { useChurn } from "@/features/churn/use-churn"
import { isAuthError } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { DEFAULT_CHURN_WINDOW, rankChurn } from "@/lib/core/churn"
import { jobLabel } from "@/lib/core/jobs"
import { useAppStore } from "@/lib/store/app-store"

/**
 * Overview card: churn over the last hour and the top churning pairs. On
 * tenants whose snapshot needed the per-job fallback it waits for a click,
 * since the churn query would be just as heavy.
 */
export function ChurnCard() {
  const heavy = useAppStore((state) => state.snapshot?.method === "per-job")
  const [requested, setRequested] = React.useState(false)
  const { data, error, isPending, isFetching } = useChurn(DEFAULT_CHURN_WINDOW, !heavy || requested)
  const top = React.useMemo(() => (data ? rankChurn(data.rows, 4) : []), [data])
  const idle = heavy && !requested && !data

  return (
    <Frame className="h-full">
      <FrameHeader icon={RepeatIcon} title="Churn" meta={`last ${DEFAULT_CHURN_WINDOW}`} action={<FrameLink to={paths.churn}>Open</FrameLink>} />
      <FrameWell className="flex flex-col gap-3">
        {idle ? (
          <div className="flex h-full flex-col gap-3 py-1 text-sm">
            <p className="text-muted-foreground">
              Series that came and went in the last hour. Grafana Cloud and Mimir bill for them; an instant count hides them.
            </p>
            <Button variant="outline" size="sm" className="self-start" onClick={() => setRequested(true)}>
              Measure churn
            </Button>
          </div>
        ) : isPending && isFetching ? (
          <div className="flex flex-col gap-2 py-1">
            <Skeleton className="h-8 w-32" />
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-5" />
            ))}
          </div>
        ) : error ? (
          <p className="py-2 text-sm text-muted-foreground">
            {isAuthError(error) ? "Unauthorized (HTTP 401). Enter your token to measure churn." : `Couldn't measure churn: ${error.message}`}
          </p>
        ) : data ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-2xl font-medium tracking-tight tabular-nums">
                <AnimatedNumber value={data.summary.churned} />
              </span>
              <span className="text-sm text-muted-foreground">
                <SwapText value={`${formatChurnPercent(data.summary.churnPercent)} over ${formatNumber(data.summary.active)} active`} />
              </span>
            </div>
            {top.length ? (
              <div className="flex flex-col">
                {top.map((row) => (
                  <ListRow
                    key={`${row.job}\u0000${row.metric}`}
                    label={row.metric}
                    mono
                    to={metricPath(row.metric)}
                    value={
                      <span title={`${jobLabel(row.job)}: ${formatNumber(row.seen)} seen, ${formatNumber(row.active)} active`}>
                        {formatNumber(row.churned)} <span className="text-xs text-muted-foreground/70">{formatRatio(row.ratio)}</span>
                      </span>
                    }
                    leading={<span className={row.high ? "size-1.5 shrink-0 rounded-full bg-brand" : "size-1.5 shrink-0 rounded-full bg-foreground/25"} />}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Every series seen in the last hour is still active.</p>
            )}
          </>
        ) : null}
      </FrameWell>
    </Frame>
  )
}
