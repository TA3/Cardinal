"use client"

import * as React from "react"
import { BarChart3, ChevronDown, ChevronRight, Tag } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import { chartConfig } from "@/lib/cardinality/dashboard-helpers"
import type { MetricDrilldown, SnapshotResponse } from "@/lib/prometheus/types"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FlowView } from "@/components/cardinality/flow-view"

interface LabelAppearance {
  job?: string
  metric: string
  cardinality: number
  percentageOfMetric: number
}

interface TopLabelRow {
  label: string
  maxCardinality: number
  appearances: LabelAppearance[]
}

interface RightPaneEmptyProps {
  chartRows: { metric: string; seriesCount: number }[]
  snapshot?: SnapshotResponse | null
  metricPreviewCache?: Record<string, MetricDrilldown>
  onMetricClick?: (metric: string) => void
  onJobClick?: (job: string) => void
}

export function RightPaneEmpty({
  chartRows,
  snapshot,
  metricPreviewCache,
  onMetricClick,
  onJobClick,
}: RightPaneEmptyProps) {
  const [expandedLabels, setExpandedLabels] = React.useState<Set<string>>(new Set())

  function toggleLabel(label: string) {
    setExpandedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }

  const topJobByMetric = React.useMemo(() => {
    const lookup = new Map<string, string>()

    for (const metric of snapshot?.metrics ?? []) {
      if (metric.topJob) {
        lookup.set(metric.metric, metric.topJob)
      }
    }

    return lookup
  }, [snapshot])

  const topLabels = React.useMemo<TopLabelRow[]>(() => {
    const labelMap = new Map<string, LabelAppearance[]>()

    for (const drilldown of Object.values(metricPreviewCache ?? {})) {
      for (const label of drilldown.labels) {
        const appearance: LabelAppearance = {
          job: topJobByMetric.get(drilldown.metric),
          metric: drilldown.metric,
          cardinality: label.cardinality,
          percentageOfMetric:
            drilldown.seriesCount > 0
              ? (label.cardinality / drilldown.seriesCount) * 100
              : 0,
        }

        if (!labelMap.has(label.label)) {
          labelMap.set(label.label, [])
        }
        labelMap.get(label.label)?.push(appearance)
      }
    }

    return Array.from(labelMap.entries())
      .map(([label, appearances]) => ({
        label,
        maxCardinality: Math.max(...appearances.map((item) => item.cardinality)),
        appearances: [...appearances].sort((a, b) => b.cardinality - a.cardinality),
      }))
      .sort((a, b) => b.maxCardinality - a.maxCardinality)
  }, [metricPreviewCache, topJobByMetric])

  const topLabelMaxCardinality = topLabels[0]?.maxCardinality ?? 1

  return (
    <>
      <Card className="flex min-h-[60px] shadow-sm items-center justify-center border-dashed">
        <CardContent className="py-4 text-center">
          <p className="text-sm text-muted-foreground">
            Click a job or metric row to inspect it here.
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="chart">
        <TabsList className="w-full">
          <TabsTrigger value="chart" className="flex-1 text-xs">
            <BarChart3 className="mr-1.5 size-3.5" />
            Top metrics chart
          </TabsTrigger>
          <TabsTrigger value="labels" className="flex-1 text-xs">
            <Tag className="mr-1.5 size-3.5" />
            Top labels
          </TabsTrigger>
          <TabsTrigger value="flow" className="flex-1 text-xs">
            Flow view
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chart" className="mt-3">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <BarChart3 className="size-4 shrink-0" />
                Top 10 metrics by series
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="min-h-48 w-full">
                <BarChart data={chartRows} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="metric"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(v) => String(v).slice(0, 10)}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10 }}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent hideIndicator />}
                  />
                  <Bar
                    dataKey="seriesCount"
                    fill="var(--color-seriesCount)"
                    radius={6}
                  />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="labels" className="mt-3">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Tag className="size-4 shrink-0" />
                Highest cardinality labels
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {topLabels.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Expand metrics in a job drilldown to populate label data here.
                </div>
              ) : (
                <ScrollArea className="max-h-[60vh]">
                  <div className="divide-y">
                    {topLabels.map((entry) => {
                      const isExpanded = expandedLabels.has(entry.label)
                      const relativeRisk =
                        topLabelMaxCardinality > 0
                          ? (entry.maxCardinality / topLabelMaxCardinality) * 100
                          : 0

                      return (
                        <div key={entry.label}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                            onClick={() => toggleLabel(entry.label)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate font-mono text-sm">
                              {entry.label}
                            </span>
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {entry.appearances.length}
                            </Badge>
                            <span
                              className="shrink-0 text-xs tabular-nums"
                              style={getScaleTextStyle(relativeRisk, "risk")}
                            >
                              {entry.maxCardinality.toLocaleString()}
                            </span>
                          </button>

                          {isExpanded ? (
                            <div className="ml-6 border-l-2 border-muted/60">
                              {entry.appearances.map((appearance) => {
                                const location = appearance.job
                                  ? `${appearance.job}/${appearance.metric}`
                                  : appearance.metric

                                return (
                                  <div
                                    key={`${entry.label}-${appearance.metric}`}
                                    className="flex items-center gap-3 px-4 py-2 text-xs"
                                  >
                                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                                      {location}
                                    </span>
                                    <span
                                      className="shrink-0 tabular-nums"
                                      style={getScaleTextStyle(appearance.percentageOfMetric, "risk")}
                                    >
                                      {appearance.percentageOfMetric.toFixed(1)}%
                                    </span>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">
                                      {appearance.cardinality.toLocaleString()}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="flow" className="mt-3">
          {snapshot && onMetricClick && onJobClick ? (
            <FlowView
              snapshot={snapshot}
              onMetricClick={onMetricClick}
              onJobClick={onJobClick}
            />
          ) : (
            <Card className="flex shadow-sm min-h-[180px] items-center justify-center">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No snapshot loaded.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </>
  )
}

