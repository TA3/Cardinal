"use client"

import * as React from "react"
import { BarChart3 } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { chartConfig } from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FlowView } from "@/components/cardinality/flow-view"

interface RightPaneEmptyProps {
  chartRows: { metric: string; seriesCount: number }[]
  snapshot?: SnapshotResponse | null
  onMetricClick?: (metric: string) => void
  onJobClick?: (job: string) => void
}

export function RightPaneEmpty({
  chartRows,
  snapshot,
  onMetricClick,
  onJobClick,
}: RightPaneEmptyProps) {
  return (
    <>
      <Card className="flex min-h-[60px] items-center justify-center border-dashed">
        <CardContent className="py-4 text-center">
          <p className="text-sm text-muted-foreground">
            Click a job or metric row to inspect it here.
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="chart">
        <TabsList className="w-full">
          <TabsTrigger value="chart" className="flex-1">
            <BarChart3 className="mr-1.5 size-3.5" />
            Top metrics chart
          </TabsTrigger>
          <TabsTrigger value="flow" className="flex-1">
            Flow view
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chart" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="size-4" />
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

        <TabsContent value="flow" className="mt-3">
          {snapshot && onMetricClick && onJobClick ? (
            <FlowView
              snapshot={snapshot}
              onMetricClick={onMetricClick}
              onJobClick={onJobClick}
            />
          ) : (
            <Card className="flex min-h-[180px] items-center justify-center">
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

