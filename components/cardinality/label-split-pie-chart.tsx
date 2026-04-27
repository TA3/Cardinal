"use client"

import { Pie, PieChart, Cell, Legend } from "recharts"

import type { LabelCardinality } from "@/lib/prometheus/types"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const chartConfig = {
  cardinality: {
    label: "Cardinality",
    color: "var(--chart-1)",
  },
}

interface LabelSplitPieChartProps {
  labels: LabelCardinality[]
}

export function LabelSplitPieChart({ labels }: LabelSplitPieChartProps) {
  const pieData = labels.map((label) => ({
    name: label.label,
    value: label.cardinality,
    fill: CHART_COLORS[labels.indexOf(label) % CHART_COLORS.length],
  }))

  return (
    <ChartContainer config={chartConfig} className="h-72 w-full">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
        <Pie
          data={pieData}
          dataKey="value"
          nameKey="name"
          innerRadius={42}
          outerRadius={86}
          paddingAngle={2}
          label={({ name, percent }) =>
            percent && percent >= 0.06
              ? `${String(name).slice(0, 10)} ${(percent * 100).toFixed(0)}%`
              : ""
          }
          labelLine={false}
        >
          {pieData.map((entry) => (
            <Cell key={entry.name} fill={entry.fill} />
          ))}
        </Pie>
        <Legend verticalAlign="bottom" height={36} />
      </PieChart>
    </ChartContainer>
  )
}
