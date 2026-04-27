"use client"

import { cn } from "@/lib/utils"
import { formatNumber, type Savings } from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

interface StatsStripProps {
  snapshot: SnapshotResponse
  dropMetrics: string[]
  selectedLabelCount: number
  savings: Savings
}

export function StatsStrip({
  snapshot,
  dropMetrics,
  selectedLabelCount,
  savings,
}: StatsStripProps) {
  const hasRuleSelection = dropMetrics.length > 0 || selectedLabelCount > 0

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader className="py-4">
          <CardDescription>Total active series</CardDescription>
          <CardTitle className="text-2xl">
            {formatNumber(snapshot.totalSeries)}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="py-4">
          <CardDescription>Unique metrics</CardDescription>
          <CardTitle className="text-2xl">
            {formatNumber(snapshot.metricCount)}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="py-4">
          <CardDescription>Unique labels</CardDescription>
          <CardTitle className="text-2xl">
            {formatNumber(snapshot.labelCount)}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card
        className={cn(
          hasRuleSelection && "border-primary/40 bg-primary/5"
        )}
      >
        <CardHeader className="py-4">
          <CardDescription>Est. savings if rules applied</CardDescription>
          <CardTitle className="flex items-baseline gap-2 text-2xl">
            {savings.isEstimate ? "~" : ""}
            {formatNumber(savings.savedSeries)}
            {hasRuleSelection ? (
              <span className="text-base font-normal text-muted-foreground">
                ({savings.percent.toFixed(1)}%)
              </span>
            ) : null}
          </CardTitle>
          {hasRuleSelection ? (
            <Progress value={savings.percent} className="mt-1.5 h-1.5" />
          ) : null}
        </CardHeader>
      </Card>
    </div>
  )
}
