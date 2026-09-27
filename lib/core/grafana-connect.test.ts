import { describe, expect, it } from "vitest"

import type { GrafanaDatasource } from "@/lib/core/grafana-cloud"
import { activeLink, connectGrafana, detectGrafanaDatasources } from "@/lib/core/grafana-connect"

const ds = (type: "prometheus" | "loki", uid: string, extra: Partial<GrafanaDatasource> = {}): GrafanaDatasource => ({
  uid,
  name: extra.name ?? uid,
  type,
  isDefault: false,
  ...extra,
})

// What play.grafana.org lists anonymously (trimmed).
const PLAY = [
  ds("prometheus", "grafanacloud-ml-demo", { url: "https://machine-learning-prod-us-central-0.grafana.net/machine-learning/demo" }),
  ds("prometheus", "grafanacloud-prom", { name: "grafanacloud-play-prom", url: "https://prometheus-prod-10-prod-us-central-0.grafana.net/api/prom" }),
  ds("loki", "grafanacloud-logs", { name: "grafanacloud-play-logs", url: "https://logs-prod-us-central1.grafana.net" }),
  ds("loki", "ac4000ca-1959-45f5-aa45-2bd0898f7026", { name: "LokiNGINXLogs", url: "https://logs-prod-us-central1.grafana.net" }),
]

const base = { token: "", mode: "proxy" as const, rememberToken: false, scan: false }

describe("detectGrafanaDatasources / connectGrafana", () => {
  it("anonymous Grafana with several data sources per type: explicit choice, likeliest first", () => {
    const detection = detectGrafanaDatasources({ grafanaUrl: "https://play.grafana.org/", datasources: PLAY })
    expect(detection.anonymous).toBe(true)
    expect(detection.stack).toBeNull()
    expect(detection.metrics.choiceNeeded).toBe(true)
    // The ML endpoint is never the suggestion.
    expect(detection.metrics.preselected).toBe("grafanacloud-prom")
    expect(detection.metrics.candidates.map((item) => item.uid)).toEqual(["grafanacloud-prom", "grafanacloud-ml-demo"])
    expect(detection.metrics.candidates[1].note).toMatch(/Machine-learning/)
    expect(detection.logs.preselected).toBe("grafanacloud-logs")
    expect(detection.metrics.candidates[0].proxyUrl).toBe("https://play.grafana.org/api/datasources/proxy/uid/grafanacloud-prom")

    const plan = connectGrafana(detection, { ...base, choices: { metrics: { use: "skip" }, logs: { use: "grafana", uid: "grafanacloud-logs" } } })
    expect(plan.problems).toEqual([])
    expect(plan.skipped).toEqual(["metrics"])
    expect(plan.remember).toEqual({ metrics: null, logs: "grafanacloud-logs" })
    expect(plan.signals).toEqual([
      {
        signal: "logs",
        connection: {
          baseUrl: "https://play.grafana.org/api/datasources/proxy/uid/grafanacloud-logs",
          authMode: "none",
          instanceId: "",
          token: "",
          tenant: "",
          mode: "proxy",
          rememberToken: false,
        },
        link: {
          grafanaUrl: "https://play.grafana.org",
          uid: "grafanacloud-logs",
          name: "grafanacloud-play-logs",
          baseUrl: "https://play.grafana.org/api/datasources/proxy/uid/grafanacloud-logs",
          via: "grafana",
        },
      },
    ])
  })

  it("prefers Grafana's default, then remembers the user's choice (including skipping)", () => {
    const datasources = [ds("prometheus", "b-prom"), ds("prometheus", "a-prom", { isDefault: true }), ds("prometheus", "c-prom")]
    const first = detectGrafanaDatasources({ grafanaUrl: "https://g.example.com", token: "glsa_x", datasources })
    expect(first.metrics.preselected).toBe("a-prom")
    expect(first.anonymous).toBe(false)
    const again = detectGrafanaDatasources({ grafanaUrl: "https://g.example.com", token: "glsa_x", datasources, remembered: { metrics: "c-prom" } })
    expect(again.metrics.preselected).toBe("c-prom")
    const skipped = detectGrafanaDatasources({ grafanaUrl: "https://g.example.com", datasources, remembered: { metrics: null } })
    expect(skipped.metrics.preselected).toBeNull()
    expect(skipped.metrics.rememberedSkip).toBe(true)
    // A remembered uid that no longer exists falls back to the default.
    expect(detectGrafanaDatasources({ grafanaUrl: "https://g.example.com", datasources, remembered: { metrics: "gone" } }).metrics.preselected).toBe("a-prom")

    const plan = connectGrafana(first, { ...base, token: " glsa_x ", rememberToken: true, choices: { metrics: { use: "grafana", uid: "b-prom" } } })
    expect(plan.signals[0].connection).toMatchObject({ authMode: "bearer", token: "glsa_x", rememberToken: true })
    expect(plan.remember).toEqual({ metrics: "b-prom" })
  })

  it("handles a Grafana with none of a type", () => {
    const detection = detectGrafanaDatasources({ grafanaUrl: "https://g.example.com", datasources: [ds("prometheus", "only")] })
    expect(detection.logs.candidates).toEqual([])
    expect(detection.logs.preselected).toBeNull()
    expect(detection.logs.choiceNeeded).toBe(false)
    expect(detection.metrics.choiceNeeded).toBe(false)
    const plan = connectGrafana(detection, { ...base, choices: { metrics: { use: "grafana", uid: "only" }, logs: { use: "grafana", uid: "missing" } } })
    expect(plan.problems).toEqual(["Pick a Loki data source, or don't use Grafana for logs."])
    // Nothing chosen and no scan: nothing to do.
    expect(connectGrafana(detection, { ...base, choices: {} }).problems).toEqual(["Pick at least one data source, or scan dashboards."])
    expect(connectGrafana(detection, { ...base, scan: true, choices: {} }).problems).toEqual([])
  })

  it("spots a Grafana Cloud stack and offers Adaptive through the hosts behind its data sources", () => {
    const datasources = [
      ds("prometheus", "grafanacloud-prom", { isDefault: true, url: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom" }),
      ds("loki", "grafanacloud-logs", { url: "https://logs-prod-012.grafana.net" }),
    ]
    const detection = detectGrafanaDatasources({ grafanaUrl: "https://mystack.grafana.net", token: "glsa_x", datasources })
    expect(detection.stack).toEqual({ slug: "mystack", url: "https://mystack.grafana.net" })
    expect(detection.adaptive.metrics).toEqual({
      kind: "available",
      baseUrl: "https://prometheus-prod-01-eu-west-0.grafana.net",
      datasourceUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom",
    })
    expect(detection.adaptive.logs).toMatchObject({ kind: "available", baseUrl: "https://logs-prod-012.grafana.net" })

    const plan = connectGrafana(detection, {
      ...base,
      token: "glsa_x",
      choices: {
        metrics: { use: "cloud", uid: "grafanacloud-prom", instanceId: " 123456 ", token: "glc_abc" },
        logs: { use: "grafana", uid: "grafanacloud-logs" },
      },
    })
    expect(plan.problems).toEqual([])
    expect(plan.signals[0]).toMatchObject({
      signal: "metrics",
      connection: { baseUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom", authMode: "grafana-cloud", instanceId: "123456", token: "glc_abc", mode: "proxy" },
      link: { via: "cloud", uid: "grafanacloud-prom" },
    })
    expect(plan.signals[1].connection).toMatchObject({ authMode: "bearer", token: "glsa_x" })
    // Direct needs the stack credentials.
    const missing = connectGrafana(detection, { ...base, choices: { metrics: { use: "cloud", uid: "grafanacloud-prom", instanceId: "", token: "" } } })
    expect(missing.problems[0]).toMatch(/instance ID and an access policy token/)
  })

  it("explains a Cloud stack whose data source URLs are hidden, and ignores non-Cloud hosts", () => {
    const hidden = detectGrafanaDatasources({ grafanaUrl: "https://mystack.grafana.net", datasources: [ds("prometheus", "p"), ds("loki", "l")] })
    expect(hidden.adaptive).toEqual({ metrics: { kind: "hidden" }, logs: { kind: "hidden" } })
    const selfHosted = detectGrafanaDatasources({
      grafanaUrl: "https://grafana.example.com",
      datasources: [ds("prometheus", "p", { url: "http://prometheus:9090" }), ds("loki", "l", { url: "https://logs-prod-012.grafana.net.evil.com" })],
    })
    expect(selfHosted.adaptive).toEqual({ metrics: { kind: "none" }, logs: { kind: "none" } })
    const plan = connectGrafana(selfHosted, { ...base, choices: { metrics: { use: "cloud", uid: "p", instanceId: "1", token: "t" } } })
    expect(plan.problems[0]).toMatch(/isn't a Grafana Cloud Prometheus/)
  })

  it("activeLink holds only while the signal's URL is the applied one", () => {
    const link = { grafanaUrl: "https://g", uid: "u", name: "n", baseUrl: "https://g/api/datasources/proxy/uid/u", via: "grafana" as const }
    expect(activeLink(link, "https://g/api/datasources/proxy/uid/u/")).toBe(link)
    expect(activeLink(link, "https://prometheus.example.com")).toBeNull()
    expect(activeLink(link, "")).toBeNull()
    expect(activeLink(undefined, "https://g")).toBeNull()
  })
})
