import { ChartBarIcon } from "@phosphor-icons/react"

import { paths } from "@/app/paths"
import { FrameLink } from "@/components/frame"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { HistogramDetail } from "@/features/histograms/histogram-detail"
import { useClassicHistogram } from "@/features/histograms/use-histograms"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { histogramFamily } from "@/lib/core/families"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

/**
 * Compact histogram tooling for a `_bucket` metric's page (every job);
 * renders nothing for other metrics.
 */
export function HistogramPanel({
  metric,
  className,
}: {
  metric: string
  className?: string
}) {
  const isBucket = histogramFamily(metric).part === "bucket"
  if (!isBucket) return null
  return <Panel metric={metric} className={className} />
}

function Panel({ metric, className }: { metric: string; className?: string }) {
  const { data: family, isPending, error } = useClassicHistogram(metric)
  const jobs = useAppStore(
    (state) =>
      state.snapshot?.metrics.find((item) => item.metric === metric)?.jobs
  )
  if (!isPending && !error && !family) return null
  return (
    <Card
      id="histogram"
      size="sm"
      className={cn("scroll-mt-36 transition-shadow duration-500", className)}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartBarIcon className="size-4 text-muted-foreground" aria-hidden />
          Histogram
        </CardTitle>
        <CardDescription>
          {family
            ? `${family.les.length} buckets × ${formatNumber(family.labelSets)} label sets`
            : null}
        </CardDescription>
        <CardAction>
          <FrameLink
            to={`${paths.histograms}?family=${encodeURIComponent(histogramFamily(metric).base)}`}
          >
            All histograms
          </FrameLink>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : isPending || !family ? (
          <Skeleton className="h-40" />
        ) : (
          <HistogramDetail family={family} jobs={jobs} compact />
        )}
      </CardContent>
    </Card>
  )
}
