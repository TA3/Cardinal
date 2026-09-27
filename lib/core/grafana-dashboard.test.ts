import { matchRoutes } from "react-router"
import { describe, expect, it } from "vitest"

import { jobPath, logGroupPath, metricPath, paths } from "@/app/paths"
import {
  CARDINAL_JOB_LABEL,
  DASHBOARD_SCHEMA_VERSION,
  DEFAULT_DASHBOARD_UID,
  dataLinksOf,
  grafanaDashboard,
  summarizeDashboard,
} from "@/lib/core/grafana-dashboard"
import { jobFromParam } from "@/lib/core/jobs"

type Json = Record<string, unknown>

// The routes in app/router.tsx that the links open.
const ROUTES = [{ path: "metrics/jobs/*" }, { path: "metrics/explore/:metric" }, { path: "logs/streams/:group" }, { path: "metrics" }]
const ORIGIN = "https://cardinal.example.com"

// Grafana's data link formats (scenes formatRegistry): links default to
// "uriencode" (encodeURI), ":percentencode" is encodeURIComponent; both also
// escape !'()*.
const strict = (value: string) => value.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
const FORMATS: Record<string, (value: string) => string> = {
  uriencode: (value) => strict(encodeURI(value)),
  percentencode: (value) => strict(encodeURIComponent(value)),
  raw: (value) => value,
}

/** Interpolates a data link URL the way Grafana does, for the given variables and clicked row/series. */
function interpolate(url: string, scope: { vars: Record<string, string>; fields?: Record<string, string>; labels?: Record<string, string> }) {
  return url.replace(/\$\{([^}:]+)(?::([^}]+))?\}/g, (_, name: string, format = "uriencode") => {
    let value: string | undefined
    if (name.startsWith("__data.fields.")) value = scope.fields?.[name.slice("__data.fields.".length)]
    else if (name.startsWith("__field.labels.")) value = scope.labels?.[name.slice("__field.labels.".length)]
    else value = scope.vars[name]
    if (value === undefined) throw new Error(`Unresolved ${name} in ${url}`)
    const formatter = FORMATS[format]
    if (!formatter) throw new Error(`Unknown format ${format}`)
    return formatter(value)
  })
}

/** Evaluates the outer label_replace calls of an expression on one series' labels, as Prometheus would. */
function applyLabelReplaces(expr: string, labels: Record<string, string>) {
  const calls: Array<[dst: string, replacement: string, src: string, regex: string]> = []
  let rest = expr
  for (;;) {
    const match = rest.match(/^label_replace\((.*), "([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)"\)$/)
    if (!match) break
    calls.unshift([match[2], match[3], match[4], match[5]])
    rest = match[1]
  }
  const out = { ...labels }
  for (const [dst, replacement, src, regex] of calls) {
    const found = new RegExp(`^(?:${regex})$`).exec(out[src] ?? "")
    if (!found) continue
    const value = replacement.replace(/\$(\d+)/g, (_, group: string) => found[Number(group)] ?? "")
    if (value) out[dst] = value
    else delete out[dst]
  }
  return out
}

function panelsOf(dashboard: Json) {
  return (dashboard.panels as Json[]).filter((panel) => panel.type !== "row")
}

function exprsOf(panel: Json) {
  return ((panel.targets as Json[]) ?? []).map((target) => String(target.expr))
}

function resolve(href: string) {
  const url = new URL(href)
  expect(url.origin).toBe(ORIGIN)
  const match = matchRoutes(ROUTES, url.pathname)
  expect(match, `no route for ${url.pathname}`).not.toBeNull()
  return { route: match![0].route.path, params: match![0].params, search: url.searchParams }
}

const TRICKY_JOBS = ["api", "kube/state-metrics", "50% sampled", "with space", "", "~tilde", "~", "q?x#y&z", "ünï/cødé"]
const TRICKY_SERVICES = ["checkout", "team/a b", "100%", "x?y&z#w", "~svc"]
const METRICS = ["http_requests_total", "job:http_requests:rate5m", "__weird__"]

describe("grafanaDashboard", () => {
  const full = grafanaDashboard({ cardinalUrl: `${ORIGIN}/`, metrics: true, logs: true })

  it("builds a valid dashboard model", () => {
    expect(full.schemaVersion).toBe(DASHBOARD_SCHEMA_VERSION)
    expect(full.uid).toBe(DEFAULT_DASHBOARD_UID)
    expect(full.id).toBeNull()
    const all = full.panels as Json[]
    const ids = all.map((panel) => panel.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(all.filter((panel) => panel.type === "row").map((panel) => panel.title)).toEqual(["Metrics", "Logs"])
    for (const panel of all) {
      const grid = panel.gridPos as { x: number; w: number; h: number; y: number }
      expect(grid.x + grid.w).toBeLessThanOrEqual(24)
      expect(grid.h).toBeGreaterThan(0)
    }
    for (const panel of panelsOf(full)) {
      expect(typeof panel.description).toBe("string")
      expect((panel.targets as Json[]).length).toBeGreaterThan(0)
    }
    // Heavy queries say so.
    for (const panel of panelsOf(full).filter((panel) => exprsOf(panel).some((expr) => expr.includes('{__name__=~".+"')))) {
      expect(String(panel.description)).toMatch(/heavy.*recording rule/)
    }
    expect(JSON.parse(JSON.stringify(full))).toEqual(full)
    expect(full.links).toEqual([expect.objectContaining({ title: "Open Cardinal", url: "${cardinal_url}" })])
  })

  it("includes only the chosen sections and their variables", () => {
    const metricsOnly = grafanaDashboard({ cardinalUrl: ORIGIN })
    expect(summarizeDashboard(metricsOnly).rows).toEqual(["Metrics"])
    expect(summarizeDashboard(metricsOnly).variables).toEqual(["datasource", "cardinal_url", "job"])
    const logsOnly = grafanaDashboard({ cardinalUrl: ORIGIN, metrics: false, logs: true, logsGroupLabel: "app", uid: "my-uid", title: "Mine" })
    expect(summarizeDashboard(logsOnly).rows).toEqual(["Logs"])
    expect(summarizeDashboard(logsOnly).variables).toEqual(["logs", "cardinal_url"])
    expect(logsOnly.uid).toBe("my-uid")
    expect(logsOnly.title).toBe("Mine")
    expect(exprsOf(panelsOf(logsOnly)[0])[0]).toBe('topk(10, sum by (app) (bytes_over_time({app=~".+"}[$__auto])))')
  })

  it("rejects bad options", () => {
    expect(() => grafanaDashboard({ cardinalUrl: ORIGIN, metrics: false })).toThrow(/metrics or the logs/)
    expect(() => grafanaDashboard({ cardinalUrl: ORIGIN, uid: "has space" })).toThrow(/uid/)
    expect(() => grafanaDashboard({ cardinalUrl: ORIGIN, uid: "x".repeat(41) })).toThrow(/uid/)
    expect(() => grafanaDashboard({ cardinalUrl: "cardinal.example.com" })).toThrow(/http/)
    expect(() => grafanaDashboard({ cardinalUrl: ORIGIN, logs: true, logsGroupLabel: 'a"} or {b' })).toThrow(/label/)
  })

  it("references only defined variables, and uses every one", () => {
    const text = JSON.stringify(full)
    const defined = new Set(summarizeDashboard(full).variables)
    const builtins = new Set(["__interval", "__rate_interval", "__range", "__auto", "__all", "__data", "__field", "1"])
    const used = new Set<string>()
    for (const match of text.matchAll(/\$\{([A-Za-z0-9_]+)|\$([A-Za-z0-9_]+)/g)) {
      const name = match[1] ?? match[2]
      if (!builtins.has(name)) {
        expect(defined.has(name), `undefined variable ${name}`).toBe(true)
        used.add(name)
      }
    }
    expect([...defined].sort()).toEqual([...used].sort())
    for (const panel of panelsOf(full)) {
      const uid = (panel.datasource as { uid: string }).uid
      expect(["${datasource}", "${logs}"]).toContain(uid)
      for (const target of panel.targets as Json[]) expect((target.datasource as { uid: string }).uid).toBe(uid)
    }
    // The job filter narrows every per-job metrics query.
    for (const panel of panelsOf(full).filter((panel) => (panel.datasource as { uid: string }).uid === "${datasource}")) {
      expect(exprsOf(panel)[0]).toContain('job=~"$job"')
    }
  })

  it("links jobs to /metrics/jobs with Cardinal's encoding, for tricky names", () => {
    const vars = { cardinal_url: ORIGIN }
    const jobPanels = panelsOf(full).filter((panel) => dataLinksOf(panel).some((url) => url.includes("/metrics/jobs/")))
    expect(jobPanels.map((panel) => panel.title)).toEqual(["Series by job", "New series (churn)"])
    for (const panel of jobPanels) {
      const expr = exprsOf(panel)[0]
      const [url] = dataLinksOf(panel)
      for (const job of TRICKY_JOBS) {
        const labels = applyLabelReplaces(expr, job ? { job } : {})
        const href = interpolate(url, { vars, fields: labels, labels })
        const { route, params } = resolve(href)
        expect(route).toBe("metrics/jobs/*")
        expect(jobFromParam(params["*"]!), `${panel.title}: ${JSON.stringify(job)} → ${href}`).toBe(job)
        // Same page as Cardinal's own link to the job.
        expect(matchRoutes(ROUTES, jobPath(job))![0].params).toEqual(params)
      }
    }
    // The no-job series links to the "~" param.
    expect(interpolate(dataLinksOf(jobPanels[0])[0], { vars, fields: applyLabelReplaces(exprsOf(jobPanels[0])[0], {}) })).toBe(`${ORIGIN}/metrics/jobs/~`)
    expect(exprsOf(jobPanels[0])[0]).toContain(`"${CARDINAL_JOB_LABEL}"`)
  })

  it("links metrics to /metrics/explore/:metric", () => {
    const panel = panelsOf(full).find((item) => item.title === "Top metrics")!
    const [url] = dataLinksOf(panel)
    expect(url).toBe("${cardinal_url}/metrics/explore/${__data.fields.__name__:percentencode}")
    for (const metric of METRICS) {
      const { route, params } = resolve(interpolate(url, { vars: { cardinal_url: ORIGIN }, fields: { __name__: metric } }))
      expect(route).toBe("metrics/explore/:metric")
      expect(params.metric).toBe(metric)
      expect(matchRoutes(ROUTES, metricPath(metric))![0].params).toEqual(params)
    }
  })

  it("links log groups to /logs/streams/:group?by=, for tricky names", () => {
    const logs = panelsOf(full).filter((panel) => (panel.datasource as { uid: string }).uid === "${logs}")
    expect(logs).toHaveLength(3)
    for (const panel of logs) {
      const [url] = dataLinksOf(panel)
      for (const service of TRICKY_SERVICES) {
        const scope = { vars: { cardinal_url: ORIGIN }, fields: { service_name: service }, labels: { service_name: service } }
        const { route, params, search } = resolve(interpolate(url, scope))
        expect(route).toBe("logs/streams/:group")
        expect(params.group).toBe(service)
        expect(search.get("by")).toBe("service_name")
        expect(matchRoutes(ROUTES, logGroupPath(service))![0].params).toEqual(params)
      }
    }
  })

  it("keeps a Cardinal URL with a path, and the dashboard link opens it", () => {
    const nested = grafanaDashboard({ cardinalUrl: "https://example.com/tools/cardinal" })
    const templating = nested.templating as { list: Json[] }
    expect(templating.list.find((variable) => variable.name === "cardinal_url")?.query).toBe("https://example.com/tools/cardinal")
    const stat = panelsOf(full).find((panel) => panel.type === "stat")!
    expect(interpolate(dataLinksOf(stat)[0], { vars: { cardinal_url: ORIGIN } })).toBe(`${ORIGIN}${paths.overview}`)
  })

  it("summarizes for the preview", () => {
    const summary = summarizeDashboard(full)
    expect(summary.panels.map((panel) => `${panel.row}/${panel.type}`)).toEqual([
      "Metrics/stat",
      "Metrics/timeseries",
      "Metrics/table",
      "Metrics/table",
      "Metrics/timeseries",
      "Logs/timeseries",
      "Logs/timeseries",
      "Logs/table",
    ])
    expect(summary.links).toBe(7)
    expect(summary.bytes).toBeGreaterThan(1000)
  })
})
