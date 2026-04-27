import { NextRequest, NextResponse } from "next/server"

import { fetchMetricSeriesForDrilldown } from "@/lib/prometheus/client"
import { MetricDrilldownRequest } from "@/lib/prometheus/types"

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as MetricDrilldownRequest

    if (!body.metric) {
      return NextResponse.json({ error: "metric is required" }, { status: 400 })
    }

    const result = await fetchMetricSeriesForDrilldown(
      body.connection,
      body.metric
    )

    return NextResponse.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch metric drilldown"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
