"use client"

import { BarChart3, Check, ChevronRight, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatNumber,
  formatPercent,
  seriesColor,
  type Savings,
} from "@/lib/cardinality/dashboard-helpers"
import type { MetricSummary, SnapshotResponse } from "@/lib/prometheus/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface MetricsTableProps {
  snapshot: SnapshotResponse
  visibleMetrics: MetricSummary[]
  dropMetrics: string[]
  savings: Savings
  selectedMetric: string | null
  activePanel: "job" | "metric" | null
  filterByJob: string | null
  onMetricClick: (metric: string) => void
  onToggleDrop: (metric: string) => void
  onDropTop5: () => void
  onClearAllDrop: () => void
}

export function MetricsTable({
  snapshot,
  visibleMetrics,
  dropMetrics,
  savings,
  selectedMetric,
  activePanel,
  filterByJob,
  onMetricClick,
  onToggleDrop,
  onDropTop5,
  onClearAllDrop,
}: MetricsTableProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="size-4" />
              {filterByJob
                ? `Metrics — ${filterByJob}`
                : "Top high-cardinality metrics"}
            </CardTitle>
            <CardDescription>
              {filterByJob
                ? "Metrics attributed to the selected job. Click a row to inspect labels."
                : `Top ${snapshot.topMetrics.length} metrics by active series. Click a row to inspect labels.`}
            </CardDescription>
          </div>
          {visibleMetrics.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={onDropTop5}
            >
              Drop top 5
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {/* Inline savings tally */}
        {dropMetrics.length > 0 ? (
          <div className="mb-3 flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {dropMetrics.length}
              </span>{" "}
              metric{dropMetrics.length !== 1 ? "s" : ""} selected
              {" · "}
              {savings.isEstimate ? "~" : ""}
              <span className="font-medium text-foreground">
                {formatNumber(savings.savedSeries)}
              </span>{" "}
              series removed
              {" · "}
              <span className="font-medium text-foreground">
                {savings.percent.toFixed(1)}%
              </span>{" "}
              reduction
            </span>
            <Button variant="ghost" size="xs" onClick={onClearAllDrop}>
              Clear all
            </Button>
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead className="text-right">Series</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Drop</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleMetrics.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-10 text-center text-muted-foreground"
                >
                  No metrics attributed to this job in the top-N snapshot.
                </TableCell>
              </TableRow>
            ) : (
              visibleMetrics.map((metric, index) => {
                const isDropped = dropMetrics.includes(metric.metric)
                const isSelected =
                  selectedMetric === metric.metric && activePanel === "metric"
                return (
                  <TableRow
                    key={metric.metric}
                    className={cn(
                      "cursor-pointer",
                      isSelected ? "bg-muted/60" : "hover:bg-muted/40",
                      isDropped && "opacity-60"
                    )}
                    onClick={() => onMetricClick(metric.metric)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{metric.metric}</span>
                        {index < 3 && !filterByJob ? (
                          <Badge>Top</Badge>
                        ) : null}
                        {isDropped ? (
                          <Badge variant="secondary">Queued</Badge>
                        ) : null}
                      </div>
                      <Progress
                        value={metric.percentageOfTotal}
                        className="mt-1.5 h-1 max-w-[160px]"
                      />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        seriesColor(metric.percentageOfTotal)
                      )}
                    >
                      {formatNumber(metric.seriesCount)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        seriesColor(metric.percentageOfTotal)
                      )}
                    >
                      {formatPercent(metric.percentageOfTotal)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={isDropped ? "secondary" : "outline"}
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleDrop(metric.metric)
                        }}
                      >
                        {isDropped ? (
                          <Check className="size-3" />
                        ) : (
                          <X className="size-3" />
                        )}
                        {isDropped ? "Added" : "Drop"}
                      </Button>
                    </TableCell>
                    <TableCell className="w-8 text-muted-foreground">
                      <ChevronRight className="size-4" />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
