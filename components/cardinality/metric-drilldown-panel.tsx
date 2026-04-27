"use client"

import { ArrowLeft, Check, List, Loader2, Trash2, X } from "lucide-react"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import {
  formatNumber,
} from "@/lib/cardinality/dashboard-helpers"
import type { MetricDrilldown } from "@/lib/prometheus/types"
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
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LabelSplitPieChart } from "@/components/cardinality/label-split-pie-chart"

interface MetricDrilldownPanelProps {
  selectedMetric: string | null
  metricDrilldown: MetricDrilldown | null
  isLoadingMetric: boolean
  dropMetrics: string[]
  selectedLabels: string[]
  labelValuesCache: Record<string, string[]>
  labelValuesLoading: Record<string, boolean>
  jobDrilldownCollapsed: boolean
  onToggleDrop: (metric: string) => void
  onToggleLabel: (metric: string, label: string) => void
  onFetchLabelValues: (metric: string, label: string) => void
  onBackToJobs?: () => void
  onClearContext?: () => void
  onClose: () => void
}

export function MetricDrilldownPanel({
  selectedMetric,
  metricDrilldown,
  isLoadingMetric,
  dropMetrics,
  selectedLabels,
  labelValuesCache,
  labelValuesLoading,
  jobDrilldownCollapsed,
  onToggleDrop,
  onToggleLabel,
  onFetchLabelValues,
  onBackToJobs,
  onClearContext,
  onClose,
}: MetricDrilldownPanelProps) {
  const isDropped = metricDrilldown
    ? dropMetrics.includes(metricDrilldown.metric)
    : false

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Metric drilldown
            </p>
            <CardTitle className="break-all">{selectedMetric}</CardTitle>
            {metricDrilldown ? (
              <CardDescription>
                {formatNumber(metricDrilldown.seriesCount)} active series ·{" "}
                {metricDrilldown.labels.length} label
                {metricDrilldown.labels.length !== 1 ? "s" : ""}
                {selectedLabels.length > 0 ? ` · ${selectedLabels.length} dropped` : ""}
              </CardDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onBackToJobs ? (
              <Button size="sm" variant="outline" onClick={onBackToJobs}>
                <ArrowLeft className="size-3" />
                Back to jobs
              </Button>
            ) : null}
            {metricDrilldown ? (
              <Button
                size="sm"
                variant={isDropped ? "secondary" : "outline"}
                onClick={() => onToggleDrop(metricDrilldown.metric)}
              >
                {isDropped ? (
                  <Check className="size-3" />
                ) : (
                  <X className="size-3" />
                )}
                {isDropped ? "Added" : "Drop"}
              </Button>
            ) : null}
            {onClearContext ? (
              <Button size="sm" variant="ghost" onClick={onClearContext}>
                <Trash2 className="size-3" />
                Clear
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title={
                jobDrilldownCollapsed
                  ? "Back to job drilldown"
                  : "Close panel"
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoadingMetric ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : null}
        {metricDrilldown ? (() => {
          const maxCard = metricDrilldown.labels[0]?.cardinality ?? 1
          return (
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border bg-muted/10 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Label share by metric series</p>
                    <p className="text-xs text-muted-foreground">
                      Pie chart shows how much each label contributes to the metric cardinality footprint.
                    </p>
                  </div>
                  {selectedLabels.length > 0 ? (
                    <Badge variant="outline">{selectedLabels.length} labels selected</Badge>
                  ) : null}
                </div>
                <LabelSplitPieChart labels={metricDrilldown.labels} />
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label key</TableHead>
                    <TableHead className="text-right">Cardinality</TableHead>
                    <TableHead className="text-right">Drop</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metricDrilldown.labels.map((label, index) => {
                    const relPct = Math.min(
                      100,
                      (label.cardinality / maxCard) * 100
                    )
                    const absPct =
                      (label.cardinality / metricDrilldown.seriesCount) * 100
                    const isSelectedLabel = selectedLabels.includes(label.label)
                    const valuesKey = `${metricDrilldown.metric}::${label.label}`
                    const isLoadingValues = Boolean(labelValuesLoading[valuesKey])
                    const labelValues = labelValuesCache[valuesKey]
                    return (
                      <TableRow key={label.label}>
                        <TableCell>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm">{label.label}</span>
                              {index < 3 ? (
                                <Badge variant="secondary">High</Badge>
                              ) : null}
                              {isSelectedLabel ? (
                                <Badge variant="outline">Will blank values</Badge>
                              ) : null}
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                title="Fetch example values"
                                onClick={() => onFetchLabelValues(metricDrilldown.metric, label.label)}
                              >
                                {isLoadingValues ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <List className="size-3" />
                                )}
                              </Button>
                            </div>
                            {labelValues ? (
                              <div className="flex flex-wrap gap-1">
                                {labelValues.slice(0, 12).map((value) => (
                                  <Badge
                                    key={value}
                                    variant="secondary"
                                    className="font-mono text-xs"
                                  >
                                    {value}
                                  </Badge>
                                ))}
                                {labelValues.length > 12 ? (
                                  <Badge variant="outline" className="text-xs">
                                    +{labelValues.length - 12} more
                                  </Badge>
                                ) : null}
                                {labelValues.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">
                                    No values found
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <span style={getScaleTextStyle(absPct, "risk")}>
                            {formatNumber(label.cardinality)}
                          </span>
                          <Progress
                            value={relPct}
                            className="mt-1 ml-auto h-1 max-w-[120px]"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={isSelectedLabel ? "secondary" : "outline"}
                            onClick={() => onToggleLabel(metricDrilldown.metric, label.label)}
                          >
                            {isSelectedLabel ? (
                              <Check className="size-3" />
                            ) : (
                              <X className="size-3" />
                            )}
                            {isSelectedLabel ? "Selected" : "Drop label"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )
        })() : null}
      </CardContent>
    </Card>
  )
}
