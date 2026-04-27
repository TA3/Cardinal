import { NextRequest, NextResponse } from "next/server"

import { buildJobDrilldown } from "@/lib/cardinality/analysis"
import { JobDrilldownRequest } from "@/lib/prometheus/types"

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as JobDrilldownRequest

    if (!body.job) {
      return NextResponse.json({ error: "job is required" }, { status: 400 })
    }

    const result = await buildJobDrilldown(body.connection, body.job)
    return NextResponse.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch job drilldown"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
