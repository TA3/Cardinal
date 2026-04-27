import {
  JobMetricSeries,
  MetricSeriesCount,
  MetricDrilldown,
  PrometheusConnectionInput,
  PrometheusLabelValuesData,
  PrometheusResponse,
  PrometheusSeriesCountData,
} from "@/lib/prometheus/types"

const API_PREFIX = "/api/v1"

function ensureHttpBaseUrl(url: string) {
  const trimmed = url.trim()
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("Prometheus URL must start with http:// or https://")
  }
  return trimmed.replace(/\/$/, "")
}

function buildAuthHeader(input: PrometheusConnectionInput) {
  const instanceId = input.instanceId?.trim() ?? ""
  const token = input.token?.trim() ?? ""
  if (!instanceId || !token) {
    return null
  }

  const raw = `${instanceId}:${token}`
  const encoded =
    typeof window === "undefined"
      ? Buffer.from(raw).toString("base64")
      : btoa(
          String.fromCharCode(...new TextEncoder().encode(raw))
        )
  return `Basic ${encoded}`
}

function toNumber(value: string | number | undefined) {
  if (typeof value === "number") {
    return value
  }
  if (!value) {
    return 0
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function prometheusGet<T>(
  connection: PrometheusConnectionInput,
  path: string,
  query?: Record<string, string>
): Promise<T> {
  const baseUrl = ensureHttpBaseUrl(connection.baseUrl)
  const url = new URL(`${baseUrl}${API_PREFIX}${path}`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }

  let response: Response
  const authorization = buildAuthHeader(connection)
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authorization ? { Authorization: authorization } : {},
      cache: "no-store",
    })
  } catch {
    throw new Error(
      [
        "CORS_OR_PREFLIGHT: Browser blocked the request before it reached Prometheus.",
        `Target: ${url.origin}${API_PREFIX}${path}`,
        "Your Prometheus endpoint or gateway must allow cross-origin requests and OPTIONS preflight.",
        "Required response headers:",
        "- Access-Control-Allow-Origin",
        "- Access-Control-Allow-Methods: GET, OPTIONS",
        "- Access-Control-Allow-Headers: Authorization, Content-Type",
      ].join("\n")
    )
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    const details = responseText ? `: ${responseText.slice(0, 180)}` : ""
    throw new Error(
      `Prometheus request failed with status ${response.status} on ${path}${details}`
    )
  }

  const payload = (await response.json()) as PrometheusResponse<T>
  if (payload.status !== "success" || !payload.data) {
    const message = payload.error ?? "Prometheus API returned an error"
    throw new Error(message)
  }

  return payload.data
}

export async function fetchMetricNames(
  connection: PrometheusConnectionInput
): Promise<string[]> {
  return prometheusGet<string[]>(connection, "/label/__name__/values")
}

export async function fetchMetricSeriesCount(
  connection: PrometheusConnectionInput,
  metricName: string
): Promise<MetricSeriesCount> {
  const expression = `count({__name__="${metricName}"})`
  const data = await prometheusGet<PrometheusSeriesCountData>(
    connection,
    "/query",
    { query: expression }
  )
  const seriesCount = toNumber(data.result[0]?.value?.[1])

  return {
    metric: metricName,
    seriesCount,
  }
}

export async function fetchJobAggregation(
  connection: PrometheusConnectionInput
): Promise<JobMetricSeries[]> {
  const data = await prometheusGet<PrometheusSeriesCountData>(connection, "/query", {
    query: 'count by (job, __name__)({__name__!=""})',
  })

  return data.result.map((row) => ({
    job: row.metric.job ?? "unknown",
    metric: row.metric.__name__ ?? "unknown",
    seriesCount: toNumber(row.value?.[1]),
  }))
}

export async function fetchLabels(
  connection: PrometheusConnectionInput
): Promise<string[]> {
  return prometheusGet<string[]>(connection, "/labels")
}

export async function fetchLabelValues(
  connection: PrometheusConnectionInput,
  label: string
): Promise<string[]> {
  return prometheusGet<string[]>(connection, `/label/${encodeURIComponent(label)}/values`)
}

export async function fetchLabelValuesForMetricScoped(
  connection: PrometheusConnectionInput,
  metricName: string,
  label: string
): Promise<string[]> {
  return prometheusGet<string[]>(
    connection,
    `/label/${encodeURIComponent(label)}/values`,
    {
      "match[]": `{__name__="${metricName}"}`,
    }
  )
}

export async function fetchMetricSeriesForDrilldown(
  connection: PrometheusConnectionInput,
  metricName: string
): Promise<MetricDrilldown> {
  const data = await prometheusGet<PrometheusLabelValuesData>(connection, "/query", {
    query: metricName,
  })

  const valuesByLabel = new Map<string, Set<string>>()

  for (const series of data.result) {
    const labels = series.metric
    for (const [label, value] of Object.entries(labels)) {
      if (label === "__name__") {
        continue
      }
      if (!valuesByLabel.has(label)) {
        valuesByLabel.set(label, new Set())
      }
      valuesByLabel.get(label)?.add(value)
    }
  }

  const labels = Array.from(valuesByLabel.entries())
    .map(([label, values]) => ({
      label,
      cardinality: values.size,
    }))
    .sort((a, b) => b.cardinality - a.cardinality)

  return {
    metric: metricName,
    labels,
    seriesCount: data.result.length,
  }
}
