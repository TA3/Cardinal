"use client"

import {
  JobDrilldownRequest,
  JobDrilldownResponse,
  MetricDrilldown,
  MetricDrilldownRequest,
  PrometheusConnectionInput,
  SnapshotRequest,
  SnapshotResponse,
} from "@/lib/prometheus/types"

async function postJson<TInput, TOutput>(
  url: string,
  payload: TInput
): Promise<TOutput> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(errorPayload?.error ?? `Request failed: ${response.status}`)
  }

  return (await response.json()) as TOutput
}

export function fetchSnapshot(payload: SnapshotRequest) {
  return postJson<SnapshotRequest, SnapshotResponse>(
    "/api/cardinality/snapshot",
    payload
  )
}

export function fetchJobDrilldown(payload: JobDrilldownRequest) {
  return postJson<JobDrilldownRequest, JobDrilldownResponse>(
    "/api/cardinality/job",
    payload
  )
}

export function fetchMetricDrilldown(payload: MetricDrilldownRequest) {
  return postJson<MetricDrilldownRequest, MetricDrilldown>(
    "/api/cardinality/metric",
    payload
  )
}

export function fetchLabelValuesProxy(
  connection: PrometheusConnectionInput,
  metric: string,
  label: string
) {
  return postJson<
    { connection: PrometheusConnectionInput; metric: string; label: string },
    string[]
  >("/api/cardinality/label-values", {
    connection,
    metric,
    label,
  })
}
