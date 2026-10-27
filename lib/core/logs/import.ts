import { buildLogsSnapshot } from "@/lib/core/logs/snapshot"
import type { LogsRange, LogsSnapshot } from "@/lib/core/logs/types"
import { csvFields } from "@/lib/core/snapshot-import"

// A logs snapshot without giving Cardinal any credentials: the user runs one
// LogQL query (bytes per service) and optionally a second (streams per
// service) wherever they already can, and pastes the results. Labels,
// patterns and impact checks need a live connection; volume, savings and
// rules work.

const DEFAULT_LABEL = "service_name"

/** Bytes ingested per group over the range. */
export function logsBytesQuery(range: LogsRange, label = DEFAULT_LABEL) {
  return `sum by (${label}) (bytes_over_time({${label}=~".+"}[${range}]))`
}

/** Streams per group over the range: each stream is one series of count_over_time. */
export function logsStreamsQuery(range: LogsRange, label = DEFAULT_LABEL) {
  return `count by (${label}) (count_over_time({${label}=~".+"}[${range}]))`
}

/** A curl command for an instant LogQL query against a Loki URL. */
export function logsCurl(query: string, baseUrl = "http://localhost:3100") {
  const base = baseUrl.trim().replace(/\/+$/, "") || "http://localhost:3100"
  return `curl -sG '${base}/loki/api/v1/query' --data-urlencode 'query=${query}'`
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export interface LabelVector {
  label: string
  rows: Array<{ value: string; amount: number }>
}

/** The one label a `sum by (label)` result is grouped by. */
function groupLabelOf(keys: string[]) {
  const labels = keys.filter((key) => key !== "__name__")
  if (labels.length !== 1) throw new Error(`Group by exactly one label; this result has ${labels.length ? labels.join(", ") : "none"}.`)
  return labels[0]
}

/**
 * A grouped instant result: Loki's /loki/api/v1/query response, its result
 * array, or Grafana's CSV download (a label column and a value column).
 * Rows it can't read stop the import rather than undercount.
 */
export function parseLabelVector(text: string): LabelVector {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Paste the query result first.")
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
    if (!Array.isArray(result) || !result.length) throw new Error("The result is empty: no logs in that range, or the label isn't used.")
    const first = result[0]
    const label = groupLabelOf(isObject(first) && isObject(first.metric) ? Object.keys(first.metric) : [])
    const rows = result.map((item, index) => {
      const metric = isObject(item) && isObject(item.metric) ? item.metric : {}
      const value = metric[label]
      if (typeof value !== "string") throw new Error(`Result ${index + 1} has no ${label} label.`)
      const raw = isObject(item) && Array.isArray(item.value) ? item.value[1] : undefined
      const amount = Number(raw)
      if (!Number.isFinite(amount)) throw new Error(`${value} has no numeric value (${JSON.stringify(raw)}). Run it as an instant query.`)
      return { value, amount }
    })
    return { label, rows }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) throw new Error("Expected a header row and at least one data row.")
  const header = csvFields(lines[0])
  const valueColumn = header.findIndex((name) => /^(value|value #a)/i.test(name))
  if (valueColumn < 0) throw new Error("No Value column. Download the query's table as CSV.")
  const labelColumns = header.map((name, index) => ({ name, index })).filter(({ name, index }) => index !== valueColumn && !/^time$/i.test(name))
  const label = groupLabelOf(labelColumns.map(({ name }) => name))
  const labelColumn = labelColumns[0].index
  const rows = lines.slice(1).map((line, index) => {
    const fields = csvFields(line)
    const value = fields[labelColumn] ?? ""
    const amount = Number(fields[valueColumn])
    if (!Number.isFinite(amount)) throw new Error(`${value || `Row ${index + 2}`} has the value "${fields[valueColumn] ?? ""}". Download the CSV with "Formatted data" turned off.`)
    return { value, amount }
  })
  return { label, rows }
}

/**
 * A logs snapshot from the bytes result and, when given, the streams result.
 * Without the streams result, stream counts are 0 and the snapshot says so.
 */
export function logsSnapshotFromImport(input: { bytes: string; streams?: string; range: LogsRange }): LogsSnapshot {
  const bytes = parseLabelVector(input.bytes)
  const streams = input.streams?.trim() ? parseLabelVector(input.streams) : null
  if (streams && streams.label !== bytes.label) throw new Error(`The two results group by different labels (${bytes.label} and ${streams.label}).`)
  const volumes = bytes.rows.filter((row) => row.value !== "").map((row) => ({ value: row.value, bytes: row.amount }))
  const streamsByGroup: Record<string, number> = Object.create(null)
  for (const row of streams?.rows ?? []) streamsByGroup[row.value] = row.amount
  const snapshot = buildLogsSnapshot({
    host: "",
    range: input.range,
    groupLabel: bytes.label,
    selector: `{${bytes.label}=~".+"}`,
    totals: { streams: (streams?.rows ?? []).reduce((sum, row) => sum + row.amount, 0), bytes: 0 },
    volumes,
    streamsByGroup,
    labels: [],
  })
  return { ...snapshot, imported: true }
}
