import { NextRequest, NextResponse } from "next/server"

import { fetchLabelValues, fetchLabels } from "@/lib/prometheus/client"
import { PrometheusConnectionInput } from "@/lib/prometheus/types"

interface LabelsRequest {
  connection: PrometheusConnectionInput
  label?: string
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as LabelsRequest

    const labels = await fetchLabels(body.connection)
    const sample = labels.slice(0, 20)

    const valuesByLabel = await Promise.all(
      sample.map(async (label) => {
        const values = await fetchLabelValues(body.connection, label)
        return {
          label,
          values: values.slice(0, 100),
          valueCount: values.length,
        }
      })
    )

    if (body.label) {
      const values = await fetchLabelValues(body.connection, body.label)
      return NextResponse.json({
        labels,
        selectedLabel: body.label,
        selectedValues: values,
        sampleValues: valuesByLabel,
      })
    }

    return NextResponse.json({
      labels,
      sampleValues: valuesByLabel,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch labels"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
