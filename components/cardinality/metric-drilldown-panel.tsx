"use client"

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
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import {
  formatNumber,
} from "@/lib/cardinality/dashboard-helpers"
import { fetchLabelValues } from "@/lib/prometheus/client"
import type { MetricDrilldown, PrometheusConnectionInput } from "@/lib/prometheus/types"
import { ArrowLeft, Check, Loader2, Sparkles, Trash2, X } from "lucide-react"
import * as React from "react"

interface MetricDrilldownPanelProps {
  selectedMetric: string | null
  metricDrilldown: MetricDrilldown | null
  isLoadingMetric: boolean
  dropMetrics: string[]
  selectedLabels: string[]
  labelValuesCache: Record<string, string[]>
  labelValuesLoading: Record<string, boolean>
  jobDrilldownCollapsed: boolean
  connection: PrometheusConnectionInput | null
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
  connection,
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

  // Label-value sampling state — keyed by metric so it auto-resets on change
  const [labelState, setLabelState] = React.useState<{
    metric: string | null
    values: Record<string, string[]>
    loading: Record<string, boolean>
  }>({ metric: null, values: {}, loading: {} })

  const currentMetric = metricDrilldown?.metric ?? null
  const labelValues =
    labelState.metric === currentMetric ? labelState.values : {}
  const loadingLabels =
    labelState.metric === currentMetric ? labelState.loading : {}

  async function handleFetchLabelValues(labelName: string) {
    if (!connection) return
    setLabelState((prev) => ({
      metric: currentMetric,
      values: prev.metric === currentMetric ? prev.values : {},
      loading: {
        ...(prev.metric === currentMetric ? prev.loading : {}),
        [labelName]: true,
      },
    }))
    try {
      const values = await fetchLabelValues(connection, labelName)
      setLabelState((prev) => ({
        metric: currentMetric,
        values: {
          ...(prev.metric === currentMetric ? prev.values : {}),
          [labelName]: values,
        },
        loading: {
          ...(prev.metric === currentMetric ? prev.loading : {}),
          [labelName]: false,
        },
      }))
    } catch {
      setLabelState((prev) => ({
        metric: currentMetric,
        values: prev.metric === currentMetric ? prev.values : {},
        loading: {
          ...(prev.metric === currentMetric ? prev.loading : {}),
          [labelName]: false,
        },
      }))
    }
  }

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label key</TableHead>
                  <TableHead className="text-right">Cardinality</TableHead>
                  <TableHead className="w-8" />
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
                  const examples = labelValues[label.label]
                  const isLoadingThis = !!loadingLabels[label.label]
                  return (
                    <TableRow key={label.label}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{label.label}</span>
                          {index < 3 ? (
                            <Badge variant="secondary">High</Badge>
                          ) : null}
                        </div>
                        {examples ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {examples.slice(0, 6).map((v) => (
                              <Badge
                                key={v}
                                variant="outline"
                                className="font-mono text-xs"
                              >
                                {v}
                              </Badge>
                            ))}
                            {examples.length > 6 ? (
                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                +{examples.length - 6} more
                              </Badge>
                            ) : null}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <span style={getScaleTextStyle(absPct, "risk")}>
                          {formatNumber(label.cardinality)}
                        </span>
                        <Progress
                          value={relPct}
                          className="mt-1 ml-auto h-1 max-w-[80px]"
                        />
                      </TableCell>
                      <TableCell className="w-8">
                        {connection ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Fetch example values"
                            disabled={isLoadingThis}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleFetchLabelValues(label.label)
                            }}
                          >
                            {isLoadingThis ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Sparkles className="size-3" />
                            )}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )
        })() : null}
      </CardContent>
    </Card>
  )
}
