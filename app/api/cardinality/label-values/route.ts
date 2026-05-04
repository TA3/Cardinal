import { NextRequest, NextResponse } from "next/server"

import { fetchLabelValuesForMetricScoped } from "@/lib/prometheus/client"
import { PrometheusConnectionInput } from "@/lib/prometheus/types"

interface LabelValuesRequest {
  connection: PrometheusConnectionInput
  metric: string
  label: string
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as LabelValuesRequest

    if (!body.connection || !body.metric || !body.label) {
      return NextResponse.json(
        { error: "Missing required fields: connection, metric, label" },
        { status: 400 }
      )
    }

    const values = await fetchLabelValuesForMetricScoped(
      body.connection,
      body.metric,
      body.label
    )

    return NextResponse.json(values)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch label values"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
