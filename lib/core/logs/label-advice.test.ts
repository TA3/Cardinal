import { describe, expect, it } from "vitest"

import { adviseLogLabel, guardedLogLabel, labelStatsFromStreams } from "@/lib/core/logs/label-advice"
import {
  exprUsesLabel,
  extractLogSelectors,
  logQueriesOfDashboard,
  matchLogQuery,
  parseLokiRulesJson,
  parseLokiRulesYaml,
  summarizeLogUsage,
  type LogQueryRef,
} from "@/lib/core/logs/logql-usage"
import { streamSelector } from "@/lib/core/logql"
import type { StreamSelector } from "@/lib/core/logs/types"

const sel = (matchers: Record<string, string>): StreamSelector => ({ matchers: Object.entries(matchers).map(([label, value]) => ({ label, op: "=", value })) })

describe("adviseLogLabel", () => {
  it("keeps guarded labels whatever their cardinality", () => {
    expect(adviseLogLabel({ label: "service_name", distinctValues: 5000, idLike: true }).kind).toBe("keep")
    expect(guardedLogLabel("namespace")?.title).toContain("namespace")
    expect(guardedLogLabel("pod")).toBeUndefined()
  })

  it("moves a label with one value per stream to structured metadata", () => {
    const advice = adviseLogLabel({ label: "pod", distinctValues: 480, streams: 500 })
    expect(advice).toMatchObject({ kind: "label_to_metadata", strength: "strong" })
    expect(advice.reason).toContain("One value per stream")
  })

  it("moves ID-like high-cardinality labels, and suggests it for very high cardinality", () => {
    expect(adviseLogLabel({ label: "request_id", distinctValues: 200, idLike: true })).toMatchObject({ kind: "label_to_metadata", strength: "strong" })
    expect(adviseLogLabel({ label: "path", distinctValues: 4000 })).toMatchObject({ kind: "label_to_metadata", strength: "suggested" })
  })

  it("drops constants, watches small ID-like labels and keeps bounded ones", () => {
    expect(adviseLogLabel({ label: "env", distinctValues: 1 }).kind).toBe("drop_label")
    // A capped value list is a lower bound, not a constant.
    expect(adviseLogLabel({ label: "env", distinctValues: 1, truncated: true }).kind).toBe("keep")
    expect(adviseLogLabel({ label: "user", distinctValues: 12, idLike: true }).kind).toBe("watch")
    expect(adviseLogLabel({ label: "level", distinctValues: 5, streams: 100 })).toMatchObject({ kind: "keep", strength: "none" })
    // Few streams don't make "one value per stream" meaningful.
    expect(adviseLogLabel({ label: "container", distinctValues: 3, streams: 3 }).kind).toBe("keep")
  })
})

describe("labelStatsFromStreams", () => {
  const series: Array<Record<string, string>> = [
    { service_name: "api", pod: "api-1", level: "info" },
    { service_name: "api", pod: "api-2", level: "info" },
    { service_name: "api", pod: "api-2", level: "error" },
    { service_name: "api", pod: "api-3", level: "error", __stream_shard__: "1" },
  ]

  it("counts distinct values, streams and the streams left without each label", () => {
    const stats = labelStatsFromStreams(series)
    const byLabel = Object.fromEntries(stats.map((stat) => [stat.label, stat]))
    expect(stats.map((stat) => stat.label)).toEqual(["pod", "level", "service_name"])
    expect(byLabel.pod).toMatchObject({ distinctValues: 3, streams: 4, streamsIfDropped: 2 })
    expect(byLabel.level).toMatchObject({ distinctValues: 2, streamsIfDropped: 3 })
    expect(byLabel.service_name).toMatchObject({ distinctValues: 1, streamsIfDropped: 4 })
    expect(byLabel.pod.values[0]).toEqual({ value: "api-2", streams: 2 })
    expect(stats.some((stat) => stat.label.startsWith("__"))).toBe(false)
  })

  it("flags ID-like values", () => {
    const ids = Array.from({ length: 10 }, (_, index) => ({ app: "x", trace: `4bf92f3577b34da6a3ce929d0e0e47${String(index).padStart(2, "0")}` }))
    expect(labelStatsFromStreams(ids).find((stat) => stat.label === "trace")?.idLike).toBe(true)
  })
})

describe("extractLogSelectors", () => {
  it("finds every stream selector, skipping strings and PromQL metric selectors", () => {
    const expr =
      'sum(count_over_time({job="nginx", status=~"5.."} |= "error" | line_format "{{.status}}" [5m])) / sum(count_over_time({job="nginx"}[5m])) + on() up{job="nginx"}'
    const selectors = extractLogSelectors(expr)
    expect(selectors.map((selector) => streamSelector(selector))).toEqual(['{job="nginx", status=~"5.."}', '{job="nginx"}'])
  })

  it("treats Grafana variables as any value", () => {
    const [selector] = extractLogSelectors('{service_name="$service", env!="${env}", app=~"[[app]]"} |= "x"')
    expect(selector.matchers).toEqual([
      { label: "service_name", op: "=~", value: ".+" },
      { label: "env", op: "=~", value: ".*" },
      { label: "app", op: "=~", value: ".+" },
    ])
  })

  it("reads backtick values and ignores non-selectors", () => {
    expect(extractLogSelectors("count_over_time({app_id=`2621`, kind=`event`} | logfmt [2m])")[0].matchers).toHaveLength(2)
    expect(extractLogSelectors('{"not": "a selector"}')).toEqual([])
    expect(exprUsesLabel('sum by (pod) (rate({app="x"} |= "pod" [1m]))', "pod")).toBe(true)
    expect(exprUsesLabel('sum(rate({app="x"} |= "pod" [1m]))', "pod")).toBe(false)
  })
})

describe("Loki rules parsing", () => {
  it("reads the Prometheus-style JSON", () => {
    const refs = parseLokiRulesJson({
      status: "success",
      data: {
        groups: [
          {
            name: "api",
            file: "team-a",
            rules: [
              { name: "HighErrors", type: "alerting", query: 'sum(rate({service_name="api"} |= "error" [5m])) > 1' },
              { name: "api:lines", type: "recording", query: 'sum(count_over_time({service_name="api"}[1m]))' },
            ],
          },
        ],
      },
    })
    expect(refs.map((ref) => [ref.kind, ref.name, ref.where])).toEqual([
      ["alerting", "HighErrors", "team-a › api"],
      ["recording", "api:lines", "team-a › api"],
    ])
    expect(refs[0].selectors[0].matchers[0].value).toBe("api")
    expect(() => parseLokiRulesJson({ data: {} })).toThrow()
  })

  it("reads the ruler YAML, including block and quoted expressions", () => {
    const yaml = [
      "team-a:",
      "    - name: api",
      "      rules:",
      "        - alert: HighErrors",
      "          expr: |",
      '            sum(rate({service_name="api"} |= "error" [5m]))',
      "              > 1",
      "          for: 5m",
      "        - record: api:lines",
      `          expr: 'sum(count_over_time({service_name="api", level="info"}[1m]))'`,
      "team-b:",
      "    - name: web",
      "      rules:",
      "        - record: web:bytes",
      "          expr: sum(bytes_over_time({app=`web`}[1m]))",
    ].join("\n")
    const refs = parseLokiRulesYaml(yaml)
    expect(refs.map((ref) => [ref.kind, ref.name, ref.where])).toEqual([
      ["alerting", "HighErrors", "team-a › api"],
      ["recording", "api:lines", "team-a › api"],
      ["recording", "web:bytes", "team-b › web"],
    ])
    expect(refs[0].expr).toContain("> 1")
    expect(refs[1].selectors[0].matchers).toHaveLength(2)
    expect(refs[2].selectors[0].matchers[0]).toEqual({ label: "app", op: "=", value: "web" })
  })
})

describe("matchLogQuery and summarizeLogUsage", () => {
  const query = (expr: string, kind: LogQueryRef["kind"] = "alerting", name = "Q"): LogQueryRef => ({ kind, name, where: "g", expr, selectors: extractLogSelectors(expr) })

  it("tells reads, maybe and disjoint apart for stream rules", () => {
    const target = { kind: "drop_streams" as const, selector: sel({ service_name: "api" }) }
    expect(matchLogQuery(target, query('rate({service_name="api", level="error"}[5m])'))).toBe("reads")
    expect(matchLogQuery(target, query('rate({service_name=~"api|web"}[5m])'))).toBe("reads")
    expect(matchLogQuery(target, query('rate({service_name="web"}[5m])'))).toBeNull()
    expect(matchLogQuery(target, query('rate({kind="event"}[5m])'))).toBe("maybe")
    expect(matchLogQuery(target, query('rate({service_name=~"$service"}[5m])'))).toBe("maybe")
    expect(matchLogQuery({ kind: "drop_lines", selector: { matchers: [] } }, query('rate({kind="event"}[5m])'))).toBe("reads")
  })

  it("needs the label for label rules; metadata moves only break selector matchers", () => {
    const drop = { kind: "drop_label" as const, selector: sel({ service_name: "api" }), label: "pod" }
    const move = { ...drop, kind: "label_to_metadata" as const }
    const grouped = query('sum by (pod) (count_over_time({service_name="api"}[1m]))')
    const selected = query('count_over_time({service_name="api", pod="api-1"}[1m])')
    expect(matchLogQuery(drop, grouped)).toBe("reads")
    expect(matchLogQuery(move, grouped)).toBeNull()
    expect(matchLogQuery(move, selected)).toBe("reads")
    expect(matchLogQuery(drop, query('count_over_time({service_name="api"}[1m])'))).toBeNull()
  })

  it("summarizes found, maybe, clean and unchecked sources", () => {
    const target = { kind: "drop_streams" as const, selector: sel({ service_name: "api" }) }
    const summary = summarizeLogUsage({
      target,
      rules: [query('rate({service_name="api"}[5m]) > 1', "alerting", "HighErrors"), query('rate({kind="x"}[5m])', "recording", "Other")],
      dashboards: null,
    })
    expect(summary.used).toBe(true)
    expect(summary.found[0]).toContain("1 Loki alerting rule reads these streams: HighErrors")
    expect(summary.unchecked.join(" ")).toContain("by other labels (kind)")
    expect(summary.unchecked.join(" ")).toContain("dashboards weren't checked")
    expect(summary.badge).toBe("1 alert")

    const none = summarizeLogUsage({
      target,
      rules: null,
      rulesError: "HTTP 404",
      dashboards: { queries: [], host: "grafana.example", scannedAt: new Date(0).toISOString(), dashboardsScanned: 12 },
      now: 3 * 3600_000,
    })
    expect(none.used).toBe(false)
    expect(none.unchecked[0]).toContain("couldn't be read (HTTP 404)")
    expect(none.clear).toContain("No LogQL dashboard panel reads these streams.")
    expect(none.checked[0]).toBe("Scanned 12 dashboards on grafana.example for LogQL, 3 h ago.")
  })
})

describe("logQueriesOfDashboard", () => {
  it("collects Loki targets from rows and variables, skipping Prometheus ones", () => {
    const dashboard = {
      templating: {
        list: [
          { name: "ds", type: "datasource", query: "loki" },
          { name: "pod", type: "query", datasource: { type: "loki", uid: "l" }, query: { query: 'label_values({service_name="api"}, pod)' } },
        ],
      },
      panels: [
        { id: 1, title: "Errors", datasource: { type: "loki", uid: "l" }, targets: [{ expr: 'sum(count_over_time({service_name="api"} |= "error" [1m]))' }] },
        { id: 2, title: "CPU", datasource: { type: "prometheus", uid: "p" }, targets: [{ expr: 'rate(cpu{service_name="api"}[5m])' }] },
        {
          type: "row",
          collapsed: true,
          panels: [{ id: 3, title: "Logs", datasource: "${ds}", targets: [{ expr: '{service_name="api", pod="$pod"}' }] }],
        },
        { id: 4, title: "Unknown", targets: [{ expr: '{app="x"}' }, { expr: 'count_over_time({app="x"}[1m])' }] },
      ],
    }
    const refs = logQueriesOfDashboard(dashboard, { title: "API", url: "/d/abc/api" })
    expect(refs.map((ref) => [ref.kind, ref.name])).toEqual([
      ["panel", "Errors"],
      ["panel", "Logs"],
      ["panel", "Unknown"],
      ["variable", "$pod"],
    ])
    expect(refs[0].url).toBe("/d/abc/api?viewPanel=1")
    expect(refs[1].selectors[0].matchers[1]).toEqual({ label: "pod", op: "=~", value: ".+" })
  })
})
