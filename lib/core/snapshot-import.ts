import type { JobMetricSeries } from "@/lib/prometheus/types"
import { queries } from "@/lib/core/promql"
import { buildSnapshotFromRows, type Snapshot } from "@/lib/core/snapshot"

// A snapshot without giving Cardinal any credentials: the user runs the one
// query a snapshot needs wherever they already can (Grafana Explore, curl,
// promtool) and pastes the result. Drilldowns, impact measurement and the
// agent need a live connection; everything computed from the snapshot works.

/** The query to run. Its result partitions every active series by job and metric. */
export const SNAPSHOT_QUERY = queries.seriesByJobAndMetric()

/** A curl command for the query against a Prometheus-compatible URL. */
export function snapshotCurl(baseUrl = "http://localhost:9090") {
  const base = baseUrl.trim().replace(/\/+$/, "") || "http://localhost:9090"
  return `curl -sG '${base}/api/v1/query' --data-urlencode 'query=${SNAPSHOT_QUERY}' > snapshot.json`
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

// Rows that can't be read stop the import: skipping them would undercount quietly, and the
// unreadable ones (formatted values like "12.3 K") are usually the biggest.

function rowsFromVector(result: unknown[]): JobMetricSeries[] {
  const rows: JobMetricSeries[] = []
  for (const [index, item] of result.entries()) {
    const metric = isObject(item) && isObject(item.metric) ? item.metric.__name__ : undefined
    if (typeof metric !== "string") throw new Error(`Result ${index + 1} has no __name__ label. Run ${SNAPSHOT_QUERY} exactly.`)
    const raw = isObject(item) && Array.isArray(item.value) ? item.value[1] : undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${metric} has no numeric value (${JSON.stringify(raw)}). Run it as an instant query.`)
    const labels = (item as Json).metric as Json
    rows.push({ job: typeof labels.job === "string" ? labels.job : "", metric, seriesCount: value })
  }
  return rows
}

/** One CSV line into fields, honouring quotes ("a,b" and "" escapes). */
export function csvFields(line: string) {
  const fields: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === "," || char === ";" || char === "\t") {
      fields.push(field)
      field = ""
    } else field += char
  }
  fields.push(field)
  return fields.map((value) => value.trim())
}

/** Grafana's "Download CSV" of the query as a table: a __name__ column, a job column and a value column. */
function rowsFromCsv(text: string): JobMetricSeries[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const header = csvFields(lines[0]).map((name) => name.toLowerCase())
  const metricColumn = header.findIndex((name) => name === "__name__" || name === "metric" || name === "name")
  const jobColumn = header.indexOf("job")
  const valueColumn = header.findIndex((name) => /^(value|value #a|count|series)/.test(name))
  if (metricColumn < 0 || valueColumn < 0) return []
  const rows: JobMetricSeries[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = csvFields(line)
    const value = Number(fields[valueColumn])
    if (!fields[metricColumn]) throw new Error(`Row ${index + 2} has no metric name.`)
    if (!Number.isFinite(value)) {
      throw new Error(`${fields[metricColumn]} has the value "${fields[valueColumn] ?? ""}". Download the CSV with "Formatted data" turned off.`)
    }
    rows.push({ job: jobColumn >= 0 ? (fields[jobColumn] ?? "") : "", metric: fields[metricColumn], seriesCount: value })
  }
  return rows
}

/**
 * Rows from the query's result: Prometheus' /api/v1/query response, its
 * `data.result` array, or a CSV with __name__, job and value columns.
 * Throws with what to fix when nothing usable is found.
 */
export function parseSnapshotRows(text: string): JobMetricSeries[] {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Paste the query result first.")
  let rows: JobMetricSeries[]
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error("That isn't valid JSON. Paste the whole response, or a CSV download.")
    }
    if (isObject(parsed) && parsed.status === "error") throw new Error(`The query failed: ${String(parsed.error ?? "unknown error")}`)
    const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : null
    if (data && data.resultType && data.resultType !== "vector") throw new Error(`Run it as an instant query: this result is a ${String(data.resultType)}.`)
    const result = data ? data.result : parsed
    rows = Array.isArray(result) ? rowsFromVector(result) : []
  } else rows = rowsFromCsv(trimmed)
  if (!rows.length) throw new Error(`No series counts found. The result needs __name__ and job labels: run ${SNAPSHOT_QUERY} as an instant query.`)
  return rows
}

/** A snapshot from pasted rows. Label-name counts aren't in the result, so that stat stays empty. */
export function snapshotFromImport(text: string, topN: number): Snapshot {
  return { ...buildSnapshotFromRows(parseSnapshotRows(text), null, topN), method: "import" }
}
