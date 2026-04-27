"use client"

import { BarChart3 } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { chartConfig } from "@/lib/cardinality/dashboard-helpers"
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

interface RightPaneEmptyProps {
  chartRows: { metric: string; seriesCount: number }[]
}

export function RightPaneEmpty({ chartRows }: RightPaneEmptyProps) {
  return (
    <>
      <Card className="flex min-h-[180px] items-center justify-center border-dashed">
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Click a job or metric row to inspect it here.
          </p>
        </CardContent>
      </Card>

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
    </>
  )
}
