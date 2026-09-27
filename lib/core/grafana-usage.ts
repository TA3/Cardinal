import {
  extractPromqlRefs,
  flowIncludes,
  HARMLESS_USES,
  type LabelFlow,
  type LabelUse,
  type MetricRef,
} from "@/lib/core/promql-refs"

// Usage evidence from Grafana: walks dashboard JSON (rows, collapsed rows,
// library panels, template variables) and Grafana-managed alert rules, and
// indexes which panels read each metric and how they use its labels. Pure: the
// fetching lives in lib/sources/grafana.ts.

export interface DashboardRef {
  uid: string
  title: string
  url: string
  folder?: string
}

export interface DashboardUsage {
  kind: "panel" | "variable" | "alert"
  /** Absent for alert rules. */
  dashboard?: DashboardRef
  /** Panel title, `$variable`, or the alert rule's title. */
  title: string
  url: string
  labels: Record<string, LabelUse[]>
  flow: LabelFlow
  /** The first query that referenced the metric, shortened. */
  expr: string
}

export interface ScanStats {
  dashboards: number
  panels: number
  /** PromQL queries read (panel targets, variable queries, alert queries). */
  queries: number
  /** Distinct metrics referenced by name. */
  metrics: number
  /** Queries only partly understood (a token scan found their metrics). */
  parseFailures: number
  alerts: number
  libraryPanels: number
  /** Queries for other datasources (Loki, SQL, …), skipped. */
  skippedQueries: number
}

export interface ScanProblem {
  where: string
  message: string
  url?: string
}

export interface GrafanaUsageIndex {
  version: 1
  baseUrl: string
  scannedAt: string
  stats: ScanStats
  metrics: Record<string, DashboardUsage[]>
  /** Usages whose metric is a pattern (`{__name__=~"…"}`, templated names). */
  patterns: Array<{ pattern: string; usages: DashboardUsage[] }>
  failures: Array<{ where: string; expr: string; error: string }>
  /** Dashboards or library panels that couldn't be read. */
  problems: ScanProblem[]
  /** Why Grafana-managed alert rules couldn't be read, when they couldn't. */
  alertsError?: string
}

export interface LibraryPanelRef {
  uid: string
  name: string
  dashboard: DashboardRef
  panelId?: number
  title: string
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const MAX_FAILURES = 50
const MAX_PROBLEMS = 50
const EXPR_LENGTH = 160

/** Joins a Grafana path (`/d/abc/slug`, which already carries any sub-path) to the base URL. */
export function grafanaUrl(baseUrl: string, path: string) {
  if (/^https?:\/\//.test(path)) return path
  const base = baseUrl.replace(/\/+$/, "")
  let origin = base
  let prefix = ""
  try {
    const url = new URL(base)
    origin = url.origin
    prefix = url.pathname.replace(/\/+$/, "")
  } catch {
    // keep the raw base
  }
  const clean = path.startsWith("/") ? path : `/${path}`
  return prefix && clean.startsWith(`${prefix}/`) ? `${origin}${clean}` : `${origin}${prefix}${clean}`
}

// --- datasources -----------------------------------------------------------

type DatasourceKind = "prometheus" | "other" | "mixed" | "dashboard" | "unknown"

const PROMETHEUS_TYPES = /prometheus|mimir|cortex|thanos|victoriametrics/i

function kindOfType(type: string): DatasourceKind {
  if (type === "-- Mixed --" || type === "mixed") return "mixed"
  if (type === "-- Dashboard --" || type === "dashboard") return "dashboard"
  return PROMETHEUS_TYPES.test(type) ? "prometheus" : "other"
}

function variableName(value: string) {
  return value.match(/^\$\{?([A-Za-z0-9_]+)(?::[^}]*)?\}?$/)?.[1]
}

/** Datasource variables and `__inputs` of a dashboard: name → plugin type. */
function datasourceVariables(dashboard: Json) {
  const variables = new Map<string, string>()
  for (const item of asArray((dashboard.templating as Json | undefined)?.list)) {
    if (isObject(item) && item.type === "datasource" && typeof item.name === "string") {
      variables.set(item.name, asString(item.query) ?? "")
    }
  }
  for (const input of asArray(dashboard.__inputs)) {
    if (isObject(input) && typeof input.name === "string" && typeof input.pluginId === "string") variables.set(input.name, input.pluginId)
  }
  return variables
}

function datasourceKind(datasource: unknown, variables: Map<string, string>): DatasourceKind {
  if (datasource === null || datasource === undefined || datasource === "") return "unknown"
  const resolve = (value: string): DatasourceKind => {
    const variable = variableName(value)
    if (variable) return variables.has(variable) ? kindOfType(variables.get(variable)!) : "unknown"
    if (value === "__expr__" || value === "-- Grafana --" || value === "grafana") return "other"
    if (value === "-- Mixed --") return "mixed"
    if (value === "-- Dashboard --") return "dashboard"
    return "unknown"
  }
  if (typeof datasource === "string") {
    const resolved = resolve(datasource)
    if (resolved !== "unknown") return resolved
    // A datasource referenced by name (old dashboards): guess from the name.
    if (/loki|elastic|influx|tempo|sql|graphite|cloudwatch|jaeger|zipkin|pyroscope/i.test(datasource)) return "other"
    return PROMETHEUS_TYPES.test(datasource) ? "prometheus" : "unknown"
  }
  if (isObject(datasource)) {
    const type = asString(datasource.type)
    if (type && !variableName(type)) return kindOfType(type)
    const uid = asString(datasource.uid)
    if (uid) return resolve(uid)
  }
  return "unknown"
}

/** LogQL also lives in `expr`: stream selectors followed by pipes or line filters. */
export function looksLikeLogQL(expr: string) {
  return (
    /\}\s*(\|[=~]?|!=|!~)/.test(expr) ||
    /\|\s*(json|logfmt|pattern|regexp|line_format|label_format|unwrap|unpack|decolorize|drop|keep)\b/.test(expr) ||
    /\b(count_over_time|bytes_over_time|bytes_rate)\s*\(\s*\{/.test(expr)
  )
}

// --- the index builder -----------------------------------------------------

interface QueryContext {
  kind: DashboardUsage["kind"]
  dashboard?: DashboardRef
  title: string
  url: string
}

function emptyStats(): ScanStats {
  return { dashboards: 0, panels: 0, queries: 0, metrics: 0, parseFailures: 0, alerts: 0, libraryPanels: 0, skippedQueries: 0 }
}

function mergeFlow(a: LabelFlow, b: LabelFlow): LabelFlow {
  if (a.all && b.all) return { all: true, except: a.except.filter((label) => b.except.includes(label)) }
  if (a.all && !b.all) return { all: true, except: a.except.filter((label) => !b.only.includes(label)) }
  if (!a.all && b.all) return mergeFlow(b, a)
  return { all: false, only: Array.from(new Set([...(a as { only: string[] }).only, ...(b as { only: string[] }).only])).sort() }
}

function mergeLabels(target: Record<string, LabelUse[]>, source: Record<string, LabelUse[]>) {
  for (const [label, uses] of Object.entries(source)) {
    const list = (target[label] ??= [])
    for (const use of uses) if (!list.some((item) => item.kind === use.kind && item.text === use.text)) list.push(use)
  }
}

export class UsageIndexBuilder {
  private readonly stats = emptyStats()
  private readonly metrics = new Map<string, Map<string, DashboardUsage>>()
  private readonly patterns = new Map<string, Map<string, DashboardUsage>>()
  private readonly failures: GrafanaUsageIndex["failures"] = []
  private readonly problems: ScanProblem[] = []
  private alertsError: string | undefined

  constructor(readonly baseUrl: string) {}

  private addRef(context: QueryContext, ref: MetricRef, expr: string) {
    const bucket = ref.metric !== undefined ? this.metrics : this.patterns
    const key = ref.metric ?? ref.pattern!
    const usages = bucket.get(key) ?? new Map<string, DashboardUsage>()
    bucket.set(key, usages)
    const id = `${context.kind}|${context.url}|${context.title}`
    const existing = usages.get(id)
    if (existing) {
      mergeLabels(existing.labels, ref.labels)
      existing.flow = mergeFlow(existing.flow, ref.flow)
      return
    }
    const labels: Record<string, LabelUse[]> = {}
    mergeLabels(labels, ref.labels)
    usages.set(id, {
      kind: context.kind,
      ...(context.dashboard ? { dashboard: context.dashboard } : {}),
      title: context.title,
      url: context.url,
      labels,
      flow: ref.flow,
      expr: expr.length > EXPR_LENGTH ? `${expr.slice(0, EXPR_LENGTH - 1)}…` : expr,
    })
  }

  /** Reads one PromQL query into the index. */
  addQuery(context: QueryContext, expr: string, legend?: string, extra?: (ref: MetricRef) => void) {
    const trimmed = expr.trim()
    if (!trimmed) return
    this.stats.queries += 1
    const { refs, error } = extractPromqlRefs(trimmed, { legend })
    if (error) {
      this.stats.parseFailures += 1
      if (this.failures.length < MAX_FAILURES) this.failures.push({ where: `${context.dashboard?.title ?? "Alert"} › ${context.title}`, expr: trimmed.slice(0, 300), error })
    }
    for (const ref of refs) {
      extra?.(ref)
      this.addRef(context, ref, trimmed)
    }
  }

  private addTargets(context: QueryContext, panel: Json, variables: Map<string, string>) {
    const panelKind = datasourceKind(panel.datasource, variables)
    for (const target of asArray(panel.targets)) {
      if (!isObject(target)) continue
      const expr = asString(target.expr)
      if (expr === undefined) {
        this.stats.skippedQueries += 1
        continue
      }
      const targetKind = datasourceKind(target.datasource, variables)
      const kind = targetKind !== "unknown" && targetKind !== "mixed" ? targetKind : panelKind === "mixed" ? targetKind : panelKind
      if (kind === "other" || kind === "dashboard" || looksLikeLogQL(expr)) {
        this.stats.skippedQueries += 1
        continue
      }
      this.addQuery(context, expr, asString(target.legendFormat))
    }
  }

  /** Every panel of a dashboard, rows and collapsed rows included. */
  private *panelsOf(list: unknown): Generator<Json> {
    for (const panel of asArray(list)) {
      if (!isObject(panel)) continue
      if (panel.type !== "row") yield panel
      // Collapsed rows keep their panels inside the row.
      if (Array.isArray(panel.panels)) yield* this.panelsOf(panel.panels)
    }
  }

  /**
   * Adds a dashboard (the `dashboard` object of /api/dashboards/uid/:uid, or a
   * dashboard JSON export). Returns library panels whose model must be fetched.
   */
  addDashboard(dashboard: unknown, meta: { url?: string; folder?: string } = {}): LibraryPanelRef[] {
    if (!isObject(dashboard)) return []
    this.stats.dashboards += 1
    const uid = asString(dashboard.uid) ?? ""
    const ref: DashboardRef = {
      uid,
      title: asString(dashboard.title) ?? (uid || "Untitled dashboard"),
      url: grafanaUrl(this.baseUrl, meta.url ?? `/d/${encodeURIComponent(uid)}`),
      ...(meta.folder ? { folder: meta.folder } : {}),
    }
    const variables = datasourceVariables(dashboard)
    const libraries: LibraryPanelRef[] = []

    // Old (schema < 16) dashboards keep panels in rows[].panels.
    const panels = [...this.panelsOf(dashboard.panels), ...asArray(dashboard.rows).flatMap((row) => (isObject(row) ? [...this.panelsOf(row.panels)] : []))]
    for (const panel of panels) {
      this.stats.panels += 1
      const id = typeof panel.id === "number" ? panel.id : undefined
      const title = asString(panel.title)?.trim() || (id !== undefined ? `Panel ${id}` : "Untitled panel")
      const library = isObject(panel.libraryPanel) ? panel.libraryPanel : null
      if (library && !Array.isArray(panel.targets) && typeof library.uid === "string") {
        libraries.push({ uid: library.uid, name: asString(library.name) ?? library.uid, dashboard: ref, panelId: id, title })
        continue
      }
      const url = id !== undefined ? `${ref.url}${ref.url.includes("?") ? "&" : "?"}viewPanel=${id}` : ref.url
      this.addTargets({ kind: "panel", dashboard: ref, title, url }, panel, variables)
    }

    for (const variable of asArray((dashboard.templating as Json | undefined)?.list)) {
      if (!isObject(variable) || variable.type !== "query") continue
      const kind = datasourceKind(variable.datasource, variables)
      if (kind === "other" || kind === "dashboard") continue
      const query = isObject(variable.query) ? asString(variable.query.query) : asString(variable.query)
      if (!query) continue
      const name = asString(variable.name) ?? "variable"
      this.addVariableQuery({ kind: "variable", dashboard: ref, title: `$${name}`, url: ref.url }, query)
    }
    return libraries
  }

  /** `label_values(selector, label)`, `query_result(expr)`, or plain PromQL. */
  private addVariableQuery(context: QueryContext, query: string) {
    const labelValues = query.match(/^\s*label_values\s*\(([\s\S]*),\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/)
    if (labelValues) {
      const [, selector, label] = labelValues
      this.addQuery(context, selector, undefined, (ref) => {
        const list = (ref.labels[label] ??= [])
        list.push({ kind: "variable", text: `label_values (${label})` })
      })
      return
    }
    if (/^\s*(label_values|metrics|label_names)\s*\(/.test(query)) return
    const result = query.match(/^\s*query_result\s*\(([\s\S]*)\)\s*$/)
    this.addQuery(context, result ? result[1] : query)
  }

  /** Adds a library panel's model (from /api/library-elements/:uid) where a dashboard uses it. */
  addLibraryPanel(ref: LibraryPanelRef, model: unknown) {
    if (!isObject(model)) return
    this.stats.libraryPanels += 1
    const url = ref.panelId !== undefined ? `${ref.dashboard.url}${ref.dashboard.url.includes("?") ? "&" : "?"}viewPanel=${ref.panelId}` : ref.dashboard.url
    const title = asString(model.title)?.trim() || ref.title
    this.addTargets({ kind: "panel", dashboard: ref.dashboard, title, url }, model, new Map())
  }

  /**
   * Grafana-managed alert rules: the provisioning API's array, or the ruler
   * API's `{ folder: [{ name, rules: [{ grafana_alert }] }] }`.
   */
  addAlertRules(payload: unknown) {
    const rules: Json[] = []
    if (Array.isArray(payload)) rules.push(...payload.filter(isObject))
    else if (isObject(payload)) {
      for (const groups of Object.values(payload)) {
        for (const group of asArray(groups)) {
          if (!isObject(group)) continue
          for (const rule of asArray(group.rules)) {
            if (isObject(rule) && isObject(rule.grafana_alert)) rules.push(rule.grafana_alert)
          }
        }
      }
    }
    for (const rule of rules) {
      this.stats.alerts += 1
      const uid = asString(rule.uid) ?? ""
      const context: QueryContext = {
        kind: "alert",
        title: asString(rule.title) ?? (uid || "Alert rule"),
        url: grafanaUrl(this.baseUrl, uid ? `/alerting/grafana/${encodeURIComponent(uid)}/view` : "/alerting/list"),
      }
      for (const query of asArray(rule.data)) {
        if (!isObject(query) || query.datasourceUid === "__expr__") continue
        const model = isObject(query.model) ? query.model : {}
        const expr = asString(model.expr)
        if (expr === undefined) continue
        if (datasourceKind(model.datasource, new Map()) === "other" || looksLikeLogQL(expr)) {
          this.stats.skippedQueries += 1
          continue
        }
        this.addQuery(context, expr, asString(model.legendFormat))
      }
    }
  }

  setAlertsError(message: string) {
    this.alertsError = message
  }

  problem(where: string, message: string, url?: string) {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ where, message, ...(url ? { url } : {}) })
  }

  build(scannedAt = new Date().toISOString()): GrafanaUsageIndex {
    const metrics = Object.fromEntries(Array.from(this.metrics, ([metric, usages]) => [metric, Array.from(usages.values())]))
    return {
      version: 1,
      baseUrl: this.baseUrl,
      scannedAt,
      stats: { ...this.stats, metrics: this.metrics.size },
      metrics,
      patterns: Array.from(this.patterns, ([pattern, usages]) => ({ pattern, usages: Array.from(usages.values()) })),
      failures: this.failures,
      problems: this.problems,
      ...(this.alertsError ? { alertsError: this.alertsError } : {}),
    }
  }
}

// --- reading the index -----------------------------------------------------

const compiledPatterns = new WeakMap<GrafanaUsageIndex, Array<{ regex: RegExp | null; usages: DashboardUsage[] }>>()

function patternsOf(index: GrafanaUsageIndex) {
  let compiled = compiledPatterns.get(index)
  if (!compiled) {
    compiled = index.patterns.map((entry) => {
      let regex: RegExp | null = null
      try {
        regex = new RegExp(`^(?:${entry.pattern})$`)
      } catch {
        // an RE2 construct JavaScript doesn't know: never matches
      }
      return { regex, usages: entry.usages }
    })
    compiledPatterns.set(index, compiled)
  }
  return compiled
}

/** Panels, variables and alerts that read a metric, by name or by a matching pattern. */
export function usagesForMetric(index: GrafanaUsageIndex | null | undefined, metric: string): DashboardUsage[] {
  if (!index) return []
  const exact = index.metrics[metric] ?? []
  const patterned = patternsOf(index).filter((entry) => entry.regex?.test(metric)).flatMap((entry) => entry.usages)
  return patterned.length ? [...exact, ...patterned] : exact
}

export interface LabelEvidence {
  label: string
  /** Usages that filter, group, match or display by the label: dropping it changes them. */
  used: DashboardUsage[]
  /** How they use it, most common first: `by (handler)`, `pod=~"$pod"`. */
  uses: string[]
  /** Usages that only aggregate it away (`without`, `ignoring`): dropping it changes nothing. */
  harmless: DashboardUsage[]
  harmlessUses: string[]
  /** Usages that don't name the label but show it (no aggregation removes it). */
  shown: DashboardUsage[]
}

function rankTexts(texts: string[]) {
  const counts = new Map<string, number>()
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1)
  return Array.from(counts).sort((a, b) => b[1] - a[1]).map(([text]) => text)
}

export function labelEvidence(usages: DashboardUsage[], label: string): LabelEvidence {
  const used: DashboardUsage[] = []
  const harmless: DashboardUsage[] = []
  const shown: DashboardUsage[] = []
  const texts: string[] = []
  const harmlessTexts: string[] = []
  for (const usage of usages) {
    const uses = usage.labels[label] ?? []
    const real = uses.filter((use) => !HARMLESS_USES.has(use.kind))
    if (real.length) {
      used.push(usage)
      texts.push(...real.map((use) => use.text))
    } else if (uses.length) {
      harmless.push(usage)
      harmlessTexts.push(...uses.map((use) => use.text))
    } else if (usage.kind !== "variable" && flowIncludes(usage.flow, label)) shown.push(usage)
  }
  return { label, used, uses: rankTexts(texts), harmless, harmlessUses: rankTexts(harmlessTexts), shown }
}

export interface DashboardGroup {
  /** Undefined for the group of alert rules. */
  dashboard?: DashboardRef
  usages: DashboardUsage[]
}

/** Usages grouped per dashboard (most usages first), alert rules last. */
export function groupByDashboard(usages: DashboardUsage[]): DashboardGroup[] {
  const groups = new Map<string, DashboardGroup>()
  for (const usage of usages) {
    const key = usage.dashboard ? `d:${usage.dashboard.url}` : "alerts"
    const group = groups.get(key) ?? { dashboard: usage.dashboard, usages: [] }
    group.usages.push(usage)
    groups.set(key, group)
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (!a.dashboard !== !b.dashboard) return a.dashboard ? -1 : 1
    return b.usages.length - a.usages.length || (a.dashboard?.title ?? "").localeCompare(b.dashboard?.title ?? "")
  })
}

const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString()} ${count === 1 ? word : many}`

/** "3 panels, 1 variable and 2 Grafana alert rules". */
export function describeUsageCounts(usages: DashboardUsage[]) {
  const panels = usages.filter((usage) => usage.kind === "panel").length
  const variables = usages.filter((usage) => usage.kind === "variable").length
  const alerts = usages.filter((usage) => usage.kind === "alert").length
  const parts = [
    panels ? plural(panels, "panel") : null,
    variables ? plural(variables, "dashboard variable") : null,
    alerts ? plural(alerts, "Grafana alert rule") : null,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "nothing")
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAge(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

/** A scan older than this is flagged as stale. */
export const STALE_SCAN_MS = 7 * 24 * 3600_000

export function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
