"use client"

import * as React from "react"
import { Check, ChevronDown, ChevronRight, Database, X } from "lucide-react"
import {
  getScaleFillStyle,
  getScaleTextStyle,
} from "@/lib/cardinality/color-scale"
import {
  formatNumber,
  formatPercent,
} from "@/lib/cardinality/dashboard-helpers"
import type { JobDrilldownResponse, MetricDrilldown } from "@/lib/prometheus/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface JobDrilldownPanelProps {
  selectedJob: string | null
  jobDrilldown: JobDrilldownResponse | null
  isLoadingJob: boolean
  dropMetrics: string[]
  selectedMetric: string | null
  selectedLabelsByMetric: Record<string, string[]>
  expandedMetrics: string[]
  metricPreviewCache: Record<string, MetricDrilldown>
  metricPreviewLoading: Record<string, boolean>
  metricPreviewErrors: Record<string, string>
  onMetricClick: (metric: string) => void
  onTogglePreview: (metric: string) => void
  onToggleDrop: (metric: string) => void
  onClose: () => void
}

export function JobDrilldownPanel({
  selectedJob,
  jobDrilldown,
  isLoadingJob,
  dropMetrics,
  selectedMetric,
  selectedLabelsByMetric,
  expandedMetrics,
  metricPreviewCache,
  metricPreviewLoading,
  metricPreviewErrors,
  onMetricClick,
  onTogglePreview,
  onToggleDrop,
  onClose,
}: JobDrilldownPanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Job drilldown
            </p>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4" />
              {selectedJob}
            </CardTitle>
            {jobDrilldown ? (
              <CardDescription>
                {formatNumber(jobDrilldown.totalSeries)} total series ·{" "}
                {jobDrilldown.metrics.length} metrics
              </CardDescription>
            ) : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoadingJob ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : null}
        {jobDrilldown ? (
          <ScrollArea className="max-h-[60vh] overflow-x-hidden">
          <Table className="w-full table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">Metric</TableHead>
                <TableHead className="w-24 text-right">Series</TableHead>
                <TableHead className="w-20 text-right">Share</TableHead>
                <TableHead className="w-24 text-right">Drop</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobDrilldown.metrics.map((m, index) => {
                const isDropped = dropMetrics.includes(m.metric)
                const isExpanded = expandedMetrics.includes(m.metric)
                const preview = metricPreviewCache[m.metric]
                const previewLoading = metricPreviewLoading[m.metric]
                const previewError = metricPreviewErrors[m.metric]
                const selectedLabelCount = selectedLabelsByMetric[m.metric]?.length ?? 0
                return (
                  <React.Fragment key={`${m.job}-${m.metric}`}>
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        selectedMetric === m.metric ? "bg-muted/60" : "hover:bg-muted/40"
                      )}
                      onClick={() => onMetricClick(m.metric)}
                    >
                      <TableCell className="max-w-0 w-full">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm truncate">{m.metric}</span>
                          {index < 3 ? (
                            <Badge variant="secondary">Top</Badge>
                          ) : null}
                          {selectedLabelCount > 0 ? (
                            <Badge variant="outline">{selectedLabelCount} labels</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell
                        className="text-right"
                        style={getScaleTextStyle(m.percentageOfTotal, "risk")}
                      >
                        {formatNumber(m.seriesCount)}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        style={getScaleTextStyle(m.percentageOfTotal, "risk")}
                      >
                        {formatPercent(m.percentageOfTotal)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={isDropped ? "secondary" : "outline"}
                          onClick={(e) => {
                            e.stopPropagation()
                            onToggleDrop(m.metric)
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
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            onTogglePreview(m.metric)
                          }}
                          className="pr-4"
                        >
                          {isExpanded ? (
                            <ChevronDown className="size-4" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isExpanded ? (
                      <TableRow>
                        <TableCell colSpan={5} className="bg-muted/10">
                          <div className="flex flex-col gap-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                                Label split preview
                              </p>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onMetricClick(m.metric)}
                              >
                                Open metric drilldown
                              </Button>
                            </div>
                            {previewLoading ? (
                              <div className="flex flex-col gap-2">
                                {Array.from({ length: 3 }).map((_, previewIndex) => (
                                  <Skeleton key={previewIndex} className="h-10 w-full" />
                                ))}
                              </div>
                            ) : null}
                            {previewError ? (
                              <p className="text-sm text-destructive">{previewError}</p>
                            ) : null}
                            {preview ? (
                              <div className="flex flex-col gap-2">
                                {preview.labels.map((label) => {
                                  const labelPct =
                                    preview.seriesCount > 0
                                      ? (label.cardinality / preview.seriesCount) * 100
                                      : 0
                                  return (
                                    <div
                                      key={`${m.metric}-${label.label}`}
                                      className="rounded-lg border bg-background/70 px-3 py-2"
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="truncate font-mono text-xs text-foreground">
                                            {label.label}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {formatNumber(label.cardinality)} series · {labelPct.toFixed(1)}%
                                          </p>
                                        </div>
                                        <div
                                          className="text-sm font-medium"
                                          style={getScaleTextStyle(labelPct, "risk")}
                                        >
                                          {labelPct.toFixed(1)}%
                                        </div>
                                      </div>
                                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                                        <div
                                          className="h-full rounded-full"
                                          style={{
                                            width: `${Math.min(labelPct, 100)}%`,
                                            ...getScaleFillStyle(labelPct, "risk"),
                                          }}
                                        />
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                )
              })}
            </TableBody>
          </Table>
          </ScrollArea>
        ) : null}
      </CardContent>
    </Card>
  )
}
