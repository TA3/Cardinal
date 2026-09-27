import { assertLokiLabelName } from "@/lib/core/logql"

// A Grafana dashboard (JSON model, schema 39) that shows the same overview as
// Cardinal and links back into it: click a job, metric or service and Cardinal
// opens on that page. Data sources are template variables, so the JSON imports
// into any Grafana. Every query is fixed text plus a validated label name.

export interface GrafanaDashboardOptions {
  /** Where Cardinal runs; the default of the editable `cardinal_url` variable. */
  cardinalUrl: string
  /** The Metrics row (Prometheus). Default true. */
  metrics?: boolean
  /** The Logs row (Loki). Default false. */
  logs?: boolean
  /** Loki label that groups streams (Cardinal's logs group label). Default service_name. */
  logsGroupLabel?: string
  title?: string
  uid?: string
}

export const DEFAULT_DASHBOARD_UID = "cardinal-overview"
export const DEFAULT_DASHBOARD_TITLE = "Cardinal overview"
export const DASHBOARD_SCHEMA_VERSION = 39
/** Grafana dashboard uids: at most 40 of letters, digits, "-" and "_". */
export const DASHBOARD_UID = /^[A-Za-z0-9_-]{1,40}$/

/**
 * The label the job links read. Cardinal's URLs write the empty job (series
 * without one) as "~" and escape a leading "~" as "~~" (jobToParam); data links
 * can't branch, so the queries compute that encoding with label_replace.
 */
export const CARDINAL_JOB_LABEL = "cardinal_job"

/** Cardinal routes the links open (see app/paths.ts). */
export const CARDINAL_ROUTES = {
  job: "/metrics/jobs/",
  metric: "/metrics/explore/",
  logGroup: "/logs/streams/",
} as const

const HEAVY =
  'Counts every active series with {__name__=~".+"}, which is heavy on large tenants: narrow the job variable, raise the interval, or record it with a recording rule (e.g. job:series:count = count by (job) ({__name__=~".+"})).'

type Json = Record<string, unknown>

interface Built {
  panels: Json[]
  nextY: number
}

/** Adds cardinal_job = jobToParam(job) to every series of `expr`. */
export function withCardinalJob(expr: string) {
  const copied = `label_replace(${expr}, "${CARDINAL_JOB_LABEL}", "$1", "job", "(.*)")`
  const noJob = `label_replace(${copied}, "${CARDINAL_JOB_LABEL}", "~", "job", "")`
  return `label_replace(${noJob}, "${CARDINAL_JOB_LABEL}", "~$1", "job", "(~.*)")`
}

const PROMETHEUS = { type: "prometheus", uid: "${datasource}" }
const LOKI = { type: "loki", uid: "${logs}" }

function link(title: string, url: string) {
  return { title, url, targetBlank: true }
}

function jobLink(fieldVar: string) {
  return link("Open job in Cardinal", `\${cardinal_url}${CARDINAL_ROUTES.job}\${${fieldVar}:percentencode}`)
}

function metricLink(fieldVar: string) {
  return link("Open metric in Cardinal", `\${cardinal_url}${CARDINAL_ROUTES.metric}\${${fieldVar}:percentencode}`)
}

function logGroupLink(fieldVar: string, label: string) {
  return link(`Open ${label} in Cardinal`, `\${cardinal_url}${CARDINAL_ROUTES.logGroup}\${${fieldVar}:percentencode}?by=${label}`)
}

function byName(name: string, properties: Json[]) {
  return { matcher: { id: "byName", options: name }, properties }
}

const hidden = { id: "custom.hidden", value: true }
const emptyAs = (text: string) => ({
  id: "mappings",
  value: [
    { type: "special", options: { match: "empty", result: { text } } },
    { type: "special", options: { match: "null", result: { text } } },
  ],
})

function row(id: number, title: string, y: number): Json {
  return { id, type: "row", title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] }
}

function metricsPanels(firstId: number, y: number): Built {
  const all = '{__name__=~".+", job=~"$job"}'
  const panels: Json[] = [
    row(firstId, "Metrics", y),
    {
      id: firstId + 1,
      type: "stat",
      title: "Active series",
      description: `Series in the selected jobs right now. ${HEAVY}`,
      datasource: PROMETHEUS,
      gridPos: { h: 6, w: 6, x: 0, y: y + 1 },
      maxDataPoints: 100,
      interval: "5m",
      targets: [{ refId: "A", datasource: PROMETHEUS, expr: `count(${all})`, instant: true, range: false, legendFormat: "Active series" }],
      options: { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "none", graphMode: "none", textMode: "value" },
      fieldConfig: {
        defaults: { unit: "short", decimals: 0, links: [link("Open Cardinal", "${cardinal_url}/metrics")] },
        overrides: [],
      },
    },
    {
      id: firstId + 2,
      type: "timeseries",
      title: "Active series over time",
      description: `Series count per step, at most one point every 5 minutes. ${HEAVY}`,
      datasource: PROMETHEUS,
      gridPos: { h: 6, w: 18, x: 6, y: y + 1 },
      maxDataPoints: 200,
      interval: "5m",
      targets: [{ refId: "A", datasource: PROMETHEUS, expr: `count(${all})`, range: true, legendFormat: "Active series" }],
      options: { legend: { showLegend: false, displayMode: "list", placement: "bottom" }, tooltip: { mode: "single", sort: "none" } },
      fieldConfig: { defaults: { unit: "short", custom: { fillOpacity: 12, lineWidth: 2, showPoints: "never" } }, overrides: [] },
    },
    {
      id: firstId + 3,
      type: "table",
      title: "Series by job",
      description: `Active series per job, largest first. Click a job to open it in Cardinal. ${HEAVY}`,
      datasource: PROMETHEUS,
      gridPos: { h: 10, w: 12, x: 0, y: y + 7 },
      interval: "5m",
      targets: [
        {
          refId: "A",
          datasource: PROMETHEUS,
          expr: withCardinalJob(`sort_desc(count by (job) (${all}))`),
          instant: true,
          range: false,
          format: "table",
        },
      ],
      transformations: [{ id: "organize", options: { excludeByName: { Time: true }, indexByName: { job: 0, Value: 1, [CARDINAL_JOB_LABEL]: 2 } } }],
      options: { showHeader: true, cellHeight: "sm", sortBy: [{ displayName: "Series", desc: true }] },
      fieldConfig: {
        defaults: {},
        overrides: [
          byName("job", [{ id: "displayName", value: "Job" }, { id: "links", value: [jobLink(`__data.fields.${CARDINAL_JOB_LABEL}`)] }, emptyAs("(no job)")]),
          byName(CARDINAL_JOB_LABEL, [hidden]),
          byName("Value", [
            { id: "displayName", value: "Series" },
            { id: "unit", value: "short" },
            { id: "custom.cellOptions", value: { type: "gauge", mode: "basic", valueDisplayMode: "text" } },
          ]),
        ],
      },
    },
    {
      id: firstId + 4,
      type: "table",
      title: "Top metrics",
      description: `The 20 metrics with the most series in the selected jobs. Click one to open it in Cardinal. ${HEAVY}`,
      datasource: PROMETHEUS,
      gridPos: { h: 10, w: 12, x: 12, y: y + 7 },
      interval: "5m",
      targets: [{ refId: "A", datasource: PROMETHEUS, expr: `topk(20, count by (__name__) (${all}))`, instant: true, range: false, format: "table" }],
      transformations: [{ id: "organize", options: { excludeByName: { Time: true }, indexByName: { __name__: 0, Value: 1 } } }],
      options: { showHeader: true, cellHeight: "sm", sortBy: [{ displayName: "Series", desc: true }] },
      fieldConfig: {
        defaults: {},
        overrides: [
          byName("__name__", [{ id: "displayName", value: "Metric" }, { id: "links", value: [metricLink("__data.fields.__name__")] }]),
          byName("Value", [
            { id: "displayName", value: "Series" },
            { id: "unit", value: "short" },
            { id: "custom.cellOptions", value: { type: "gauge", mode: "basic", valueDisplayMode: "text" } },
          ]),
        ],
      },
    },
    {
      id: firstId + 5,
      type: "timeseries",
      title: "New series (churn)",
      description:
        "Series created per interval, by job, from scrape_series_added (scraped targets only; empty for remote-written data), plus Prometheus' own head series creation rate when it scrapes itself. Click a line to open the job in Cardinal.",
      datasource: PROMETHEUS,
      gridPos: { h: 8, w: 24, x: 0, y: y + 17 },
      maxDataPoints: 200,
      interval: "1m",
      targets: [
        {
          refId: "A",
          datasource: PROMETHEUS,
          expr: withCardinalJob('topk(10, sum by (job) (sum_over_time(scrape_series_added{job=~"$job"}[$__interval])))'),
          range: true,
          legendFormat: "{{job}}",
        },
        {
          refId: "B",
          datasource: PROMETHEUS,
          expr: "sum(rate(prometheus_tsdb_head_series_created_total[$__rate_interval]) * 60)",
          range: true,
          legendFormat: "TSDB head (per minute)",
        },
      ],
      options: { legend: { showLegend: true, displayMode: "list", placement: "right" }, tooltip: { mode: "multi", sort: "desc" } },
      fieldConfig: {
        defaults: {
          unit: "short",
          custom: { fillOpacity: 0, lineWidth: 1, showPoints: "never" },
          links: [jobLink(`__field.labels.${CARDINAL_JOB_LABEL}`)],
        },
        overrides: [{ matcher: { id: "byFrameRefID", options: "B" }, properties: [{ id: "links", value: [] }] }],
      },
    },
  ]
  return { panels, nextY: y + 25 }
}

function logsPanels(firstId: number, y: number, label: string): Built {
  const selector = `{${label}=~".+"}`
  const heavy =
    "LogQL metric queries read the log data itself, so this is heavy over long ranges on large tenants; Cardinal's own logs snapshot reads only Loki's index."
  const panels: Json[] = [
    row(firstId, "Logs", y),
    {
      id: firstId + 1,
      type: "timeseries",
      title: `Log volume by ${label}`,
      description: `Bytes ingested per step, by ${label}. Click a line to open it in Cardinal. ${heavy}`,
      datasource: LOKI,
      gridPos: { h: 8, w: 12, x: 0, y: y + 1 },
      maxDataPoints: 200,
      interval: "5m",
      targets: [{ refId: "A", datasource: LOKI, expr: `topk(10, sum by (${label}) (bytes_over_time(${selector}[$__auto])))`, queryType: "range", legendFormat: `{{${label}}}` }],
      options: { legend: { showLegend: true, displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi", sort: "desc" } },
      fieldConfig: {
        defaults: {
          unit: "bytes",
          custom: { drawStyle: "bars", fillOpacity: 60, stacking: { mode: "normal", group: "A" }, lineWidth: 0, showPoints: "never" },
          links: [logGroupLink(`__field.labels.${label}`, label)],
        },
        overrides: [],
      },
    },
    {
      id: firstId + 2,
      type: "timeseries",
      title: `Streams by ${label}`,
      description: `Active streams per step, by ${label}: how many label combinations each one sends. ${heavy}`,
      datasource: LOKI,
      gridPos: { h: 8, w: 12, x: 12, y: y + 1 },
      maxDataPoints: 200,
      interval: "5m",
      targets: [{ refId: "A", datasource: LOKI, expr: `topk(10, count by (${label}) (count_over_time(${selector}[$__auto])))`, queryType: "range", legendFormat: `{{${label}}}` }],
      options: { legend: { showLegend: true, displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi", sort: "desc" } },
      fieldConfig: {
        defaults: { unit: "short", custom: { fillOpacity: 0, lineWidth: 1, showPoints: "never" }, links: [logGroupLink(`__field.labels.${label}`, label)] },
        overrides: [],
      },
    },
    {
      id: firstId + 3,
      type: "table",
      title: `Top ${label} values by volume`,
      description: `The 20 largest by bytes over the dashboard's time range. Click one to open it in Cardinal. ${heavy}`,
      datasource: LOKI,
      gridPos: { h: 10, w: 24, x: 0, y: y + 9 },
      targets: [{ refId: "A", datasource: LOKI, expr: `topk(20, sum by (${label}) (bytes_over_time(${selector}[$__range])))`, queryType: "instant" }],
      transformations: [
        { id: "labelsToFields", options: { mode: "columns" } },
        { id: "merge", options: {} },
        { id: "organize", options: { excludeByName: { Time: true }, indexByName: { [label]: 0, Value: 1 } } },
      ],
      options: { showHeader: true, cellHeight: "sm", sortBy: [{ displayName: "Bytes", desc: true }] },
      fieldConfig: {
        defaults: {},
        overrides: [
          byName(label, [{ id: "links", value: [logGroupLink(`__data.fields.${label}`, label)] }]),
          byName("Value", [
            { id: "displayName", value: "Bytes" },
            { id: "unit", value: "bytes" },
            { id: "custom.cellOptions", value: { type: "gauge", mode: "basic", valueDisplayMode: "text" } },
          ]),
        ],
      },
    },
  ]
  return { panels, nextY: y + 19 }
}

function cardinalUrlOf(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s/]+/.test(trimmed)) throw new Error("The Cardinal URL must start with http:// or https://")
  return trimmed
}

/** The Grafana dashboard JSON model. Throws on an invalid uid, URL or label. */
export function grafanaDashboard(options: GrafanaDashboardOptions): Json {
  const metrics = options.metrics ?? true
  const logs = options.logs ?? false
  if (!metrics && !logs) throw new Error("Include the metrics or the logs section.")
  const uid = options.uid?.trim() || DEFAULT_DASHBOARD_UID
  if (!DASHBOARD_UID.test(uid)) throw new Error("The uid takes up to 40 letters, digits, - and _.")
  const title = options.title?.trim() || DEFAULT_DASHBOARD_TITLE
  const cardinalUrl = cardinalUrlOf(options.cardinalUrl)
  const label = assertLokiLabelName(options.logsGroupLabel?.trim() || "service_name")

  const variables: Json[] = []
  if (metrics) variables.push({ name: "datasource", label: "Metrics", type: "datasource", query: "prometheus", regex: "", hide: 0, refresh: 1, current: {}, options: [] })
  if (logs) variables.push({ name: "logs", label: "Logs", type: "datasource", query: "loki", regex: "", hide: 0, refresh: 1, current: {}, options: [] })
  variables.push({
    name: "cardinal_url",
    label: "Cardinal URL",
    description: "Where the links open Cardinal. Change it if Cardinal runs elsewhere.",
    type: "textbox",
    query: cardinalUrl,
    current: { text: cardinalUrl, value: cardinalUrl },
    options: [{ selected: true, text: cardinalUrl, value: cardinalUrl }],
    hide: 0,
  })
  if (metrics) {
    variables.push({
      name: "job",
      label: "Job",
      type: "query",
      datasource: PROMETHEUS,
      definition: "label_values(job)",
      query: { query: "label_values(job)", refId: "PrometheusVariableQueryEditor-VariableQuery", qryType: 1 },
      refresh: 2,
      sort: 1,
      multi: true,
      includeAll: true,
      // Matches series without a job too.
      allValue: ".*",
      current: { text: ["All"], value: ["$__all"] },
      options: [],
      hide: 0,
    })
  }

  const panels: Json[] = []
  let y = 0
  let id = 1
  if (metrics) {
    const built = metricsPanels(id, y)
    panels.push(...built.panels)
    y = built.nextY
    id += 10
  }
  if (logs) panels.push(...logsPanels(id, y, label).panels)

  return {
    id: null,
    uid,
    title,
    description: "Cardinality overview generated by Cardinal. Click a job, metric or service to open it in Cardinal.",
    tags: ["cardinal", "cardinality"],
    timezone: "browser",
    editable: true,
    graphTooltip: 1,
    time: { from: "now-6h", to: "now" },
    refresh: "",
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    version: 1,
    fiscalYearStartMonth: 0,
    liveNow: false,
    annotations: { list: [] },
    links: [{ title: "Open Cardinal", type: "link", url: "${cardinal_url}", icon: "external link", targetBlank: true, tooltip: "Open Cardinal", asDropdown: false, includeVars: false, keepTime: false, tags: [] }],
    templating: { list: variables },
    panels,
  }
}

export interface DashboardSummary {
  rows: string[]
  panels: Array<{ title: string; type: string; row: string }>
  variables: string[]
  links: number
  bytes: number
}

/** What the dashboard holds, for the export preview. */
export function summarizeDashboard(dashboard: Json): DashboardSummary {
  const rows: string[] = []
  const panels: DashboardSummary["panels"] = []
  let links = 0
  for (const panel of (dashboard.panels as Json[]) ?? []) {
    if (panel.type === "row") {
      rows.push(String(panel.title))
      continue
    }
    panels.push({ title: String(panel.title), type: String(panel.type), row: rows[rows.length - 1] ?? "" })
    links += dataLinksOf(panel).length
  }
  const variables = (((dashboard.templating as Json | undefined)?.list as Json[]) ?? []).map((variable) => String(variable.name))
  return { rows, panels, variables, links, bytes: JSON.stringify(dashboard).length }
}

/** Every data link URL on a panel (field defaults and overrides). */
export function dataLinksOf(panel: Json): string[] {
  const config = panel.fieldConfig as { defaults?: { links?: Array<{ url: string }> }; overrides?: Array<{ properties: Array<{ id: string; value: unknown }> }> } | undefined
  const urls = (config?.defaults?.links ?? []).map((item) => item.url)
  for (const override of config?.overrides ?? []) {
    for (const property of override.properties) {
      if (property.id === "links" && Array.isArray(property.value)) urls.push(...(property.value as Array<{ url: string }>).map((item) => item.url))
    }
  }
  return urls
}
