import { NextRequest, NextResponse } from "next/server"

import { buildSnapshot } from "@/lib/cardinality/analysis"
import { SnapshotRequest } from "@/lib/prometheus/types"

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SnapshotRequest
    const topN = Math.max(1, Math.min(100, body.topN ?? 20))
    const concurrency = Math.max(10, Math.min(20, body.concurrency ?? 10))

    const snapshot = await buildSnapshot(body.connection, topN, concurrency)

    return NextResponse.json(snapshot)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build snapshot"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
