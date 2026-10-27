import { parseAllDocuments } from "yaml"

import { UsageIndexBuilder, type GrafanaUsageIndex, type LibraryPanelRef } from "@/lib/core/grafana-usage"

// Usage evidence without Grafana credentials: the same index a scan builds,
// from files the user exported themselves. Accepts dashboard JSON (the raw
// model, Grafana's "Export" with __inputs, or the API's { dashboard, meta }),
// Grafana alert rule exports (JSON or YAML), Prometheus rule files and
// PrometheusRule resources. Anything else is reported, not guessed at.

export interface UsageFile {
  name: string
  text: string
}

/** The usage index's key when no Grafana URL is set, so dashboard links can't be built. */
export const UPLOADED_USAGE_KEY = "uploaded files"

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function parseDocuments(file: UsageFile): unknown[] {
  const text = file.text.trim()
  if (!text) return []
  if (/\.json$/i.test(file.name) || text.startsWith("{") || text.startsWith("[")) return [JSON.parse(text)]
  return parseAllDocuments(text).map((document) => {
    if (document.errors.length) throw new Error(document.errors[0].message)
    return document.toJS()
  })
}

const isDashboard = (value: Json) => Array.isArray(value.panels) || Array.isArray(value.rows)

/** A Grafana-managed alert rule: its queries live in `data[].model.expr`. */
const isGrafanaRule = (value: Json) => Array.isArray(value.data)

/** A Prometheus recording or alerting rule. */
const isPrometheusRule = (value: Json) => typeof value.expr === "string" && (typeof value.alert === "string" || typeof value.record === "string")

/** Reads one parsed document into the builder; returns what it found ("rules" for Prometheus rules), or null when it recognised nothing. */
function addDocument(builder: UsageIndexBuilder, value: unknown, libraries: LibraryPanelRef[], source: string): string | null {
  if (Array.isArray(value)) {
    const found = value.map((item) => addDocument(builder, item, libraries, source)).filter(Boolean)
    return found.includes("rules") ? "rules" : (found[0] ?? null)
  }
  if (!isObject(value)) return null
  if (isObject(value.dashboard) && isDashboard(value.dashboard)) {
    const meta = isObject(value.meta) ? value.meta : {}
    libraries.push(...builder.addDashboard(value.dashboard, { url: asString(meta.url), folder: asString(meta.folderTitle) }))
    return "dashboard"
  }
  if (isDashboard(value)) {
    libraries.push(...builder.addDashboard(value))
    return "dashboard"
  }
  if (isGrafanaRule(value)) {
    builder.addAlertRules([value])
    return "alert rules"
  }
  // Rule groups: Grafana's alert export, Prometheus rule files, or a PrometheusRule's spec.
  const groups = asArray(value.groups ?? (isObject(value.spec) ? value.spec.groups : undefined))
  if (groups.length) {
    let found: string | null = null
    for (const group of groups) {
      if (!isObject(group)) continue
      const name = asString(group.name) ?? source
      for (const rule of asArray(group.rules)) {
        if (!isObject(rule)) continue
        if (isGrafanaRule(rule)) {
          builder.addAlertRules([rule])
          found = "alert rules"
        } else if (isPrometheusRule(rule)) {
          const alert = asString(rule.alert)
          builder.addRuleExpr(name, alert ?? (asString(rule.record) as string), rule.expr as string, alert !== undefined ? "alerting" : "recording")
          found = "rules"
        }
      }
    }
    return found
  }
  return null
}

/**
 * Builds a usage index from exported files. `baseUrl` is the Grafana URL the
 * dashboards came from, for links; without one the index is keyed
 * UPLOADED_USAGE_KEY and links are left out.
 */
export function buildUsageIndexFromFiles(files: UsageFile[], baseUrl = "", scannedAt?: string): GrafanaUsageIndex {
  const builder = new UsageIndexBuilder(baseUrl.trim().replace(/\/+$/, "") || UPLOADED_USAGE_KEY)
  const libraries: LibraryPanelRef[] = []
  let rulesIncluded = false
  for (const file of files) {
    try {
      const found = parseDocuments(file).map((document) => addDocument(builder, document, libraries, file.name))
      if (found.includes("rules")) rulesIncluded = true
      if (!found.some(Boolean)) builder.problem(file.name, "Not a dashboard, alert rule export or Prometheus rule file.")
    } catch (error) {
      builder.problem(file.name, `Couldn't be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Library panels live outside the dashboard JSON; exports that inline them (__elements) are read.
  const elements = new Map<string, unknown>()
  for (const file of files) {
    try {
      for (const document of parseDocuments(file)) {
        const inline = isObject(document) ? (isObject(document.dashboard) ? document.dashboard.__elements : document.__elements) : undefined
        if (isObject(inline)) for (const [uid, element] of Object.entries(inline)) if (isObject(element)) elements.set(uid, element.model)
      }
    } catch {
      // already reported
    }
  }
  for (const ref of libraries) {
    if (elements.has(ref.uid)) builder.addLibraryPanel(ref, elements.get(ref.uid))
    else builder.problem(`Library panel ${ref.name}`, "Its model isn't in the uploaded files; export the dashboard with \"Export for sharing externally\".")
  }
  return { ...builder.build(scannedAt), source: "files", ...(rulesIncluded ? { rulesIncluded } : {}) }
}
