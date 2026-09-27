import { describe, expect, it } from "vitest"

import { extractPromqlRefs, flowIncludes, legendLabels, neutralizeTemplateVariables, type MetricRef } from "@/lib/core/promql-refs"

const refsOf = (expr: string, legend?: string) => {
  const result = extractPromqlRefs(expr, { legend })
  return { ...result, byName: Object.fromEntries(result.refs.map((ref) => [ref.metric ?? `~${ref.pattern}`, ref])) as Record<string, MetricRef> }
}
const kinds = (ref: MetricRef, label: string) => (ref.labels[label] ?? []).map((use) => use.kind)
const texts = (ref: MetricRef, label: string) => (ref.labels[label] ?? []).map((use) => use.text)

describe("extractPromqlRefs", () => {
  it("reads a node exporter CPU panel with template variables", () => {
    const { byName, error } = refsOf(
      '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle", instance=~"$node", job="$job"}[$__rate_interval])) * 100)'
    )
    expect(error).toBeUndefined()
    const ref = byName.node_cpu_seconds_total
    expect(kinds(ref, "mode")).toEqual(["filter"])
    expect(texts(ref, "mode")).toEqual(['mode="idle"'])
    expect(kinds(ref, "instance")).toEqual(["variable", "by"])
    expect(texts(ref, "instance")).toContain("by (instance)")
    expect(kinds(ref, "job")).toEqual(["variable"])
    expect(ref.flow).toEqual({ all: false, only: ["instance"] })
    expect(flowIncludes(ref.flow, "cpu")).toBe(false)
  })

  it("follows histogram_quantile over sum by (le, handler)", () => {
    const { byName } = refsOf(
      'histogram_quantile(0.99, sum by (le, handler) (rate(prometheus_http_request_duration_seconds_bucket{job="prometheus"}[5m])))',
      "{{handler}}"
    )
    const ref = byName.prometheus_http_request_duration_seconds_bucket
    expect(kinds(ref, "le")).toEqual(["by", "histogram_quantile"])
    expect(kinds(ref, "handler")).toEqual(["by", "legend"])
    expect(ref.flow).toEqual({ all: false, only: ["handler"] })
  })

  it("reads grouping written after the arguments, and both sides of a division", () => {
    const { byName } = refsOf(
      'sum(kube_pod_container_resource_requests{namespace="$namespace", resource="cpu"}) by (pod) / sum(kube_pod_container_resource_limits{namespace="$namespace", resource="cpu"}) by (pod)'
    )
    expect(Object.keys(byName).sort()).toEqual(["kube_pod_container_resource_limits", "kube_pod_container_resource_requests"])
    expect(kinds(byName.kube_pod_container_resource_limits, "pod")).toEqual(["by"])
    expect(kinds(byName.kube_pod_container_resource_requests, "namespace")).toEqual(["variable"])
    expect(byName.kube_pod_container_resource_limits.flow).toEqual({ all: false, only: ["pod"] })
  })

  it("tracks on() and group_left() joins", () => {
    const { byName } = refsOf(
      'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[5m])) * on (namespace, pod) group_left(node) kube_pod_info{node=~"$node"}'
    )
    const cpu = byName.container_cpu_usage_seconds_total
    const info = byName.kube_pod_info
    expect(kinds(cpu, "pod")).toEqual(["by", "on"])
    expect(kinds(cpu, "container")).toEqual(["filter"])
    expect(kinds(info, "node")).toEqual(["variable", "group_left"])
    expect(kinds(info, "namespace")).toEqual(["on"])
    // The "many" side keeps its labels; the "one" side contributes the join and include labels.
    expect(cpu.flow).toEqual({ all: false, only: ["namespace", "pod"] })
    expect(info.flow).toEqual({ all: false, only: ["namespace", "node", "pod"] })
    expect(flowIncludes(info.flow, "uid")).toBe(false)
  })

  it("treats without() and ignoring() as harmless uses and keeps the other labels flowing", () => {
    const { byName } = refsOf("sum without (pod, instance) (rate(http_requests_total[5m])) / ignoring(code) group_left sum without (pod, instance) (rate(http_requests_total[5m]))")
    const ref = byName.http_requests_total
    expect(kinds(ref, "pod")).toEqual(["without"])
    expect(kinds(ref, "code")).toEqual(["ignoring"])
    expect(ref.flow.all).toBe(true)
    expect(flowIncludes(ref.flow, "pod")).toBe(false)
    expect(flowIncludes(ref.flow, "handler")).toBe(true)
  })

  it("reads label_replace and label_join sources", () => {
    const { byName } = refsOf('label_join(label_replace(up{job="api"}, "host", "$1", "instance", "(.*):.*"), "id", "/", "job", "pod")')
    const ref = byName.up
    expect(kinds(ref, "instance")).toEqual(["label_replace"])
    expect(kinds(ref, "pod")).toEqual(["label_join"])
    expect(kinds(ref, "job")).toEqual(["filter", "label_join"])
    expect(ref.flow).toEqual({ all: true, except: [] })
  })

  it("records regex metric matchers as patterns and ignores catch-alls", () => {
    const { refs, byName } = refsOf('sum by (device) (rate({__name__=~"node_network_(receive|transmit)_bytes_total", device!="lo"}[5m]))')
    expect(refs).toHaveLength(1)
    const ref = byName["~node_network_(receive|transmit)_bytes_total"]
    expect(kinds(ref, "device")).toEqual(["filter", "by"])
    expect(refsOf('topk(10, count by (__name__)({__name__=~".+"}))').refs).toEqual([])
    expect(refsOf('{__name__="up", job="x"}').byName.up).toBeDefined()
  })

  it("neutralises Grafana variables everywhere", () => {
    expect(neutralizeTemplateVariables("rate(x[[[interval]]])")).toBe("rate(x[$interval])")
    const templated = refsOf('sum(rate(${metric}_total{job=~"$job"}[${__interval}])) / $__interval_ms * [[scale]]')
    expect(templated.error).toBeUndefined()
    expect(templated.byName["~.*_total"]).toBeDefined()
    const suffix = refsOf("node_filesystem_${kind}_bytes / ignoring(fstype) node_filesystem_size_bytes")
    expect(suffix.byName["~node_filesystem_.*_bytes"]).toBeDefined()
    expect(suffix.byName.node_filesystem_size_bytes).toBeDefined()
    const dynamicGrouping = refsOf("sum by ($group) (rate(http_requests_total[5m]))").byName.http_requests_total
    expect(dynamicGrouping.flow.all).toBe(true)
    expect(refsOf("topk($limit, rate(x[$__range]))").byName.x.flow.all).toBe(true)
  })

  it("handles offsets, @, subqueries, comparisons, set operators and comments", () => {
    const { byName, error } = refsOf(`
      # errors over the last hour, compared with a week ago
      max_over_time(rate(http_errors_total{code=~"5.."}[5m])[1h:1m]) > bool 0.5
        and on(service) (http_errors_total offset 1w @ end())
      or vector(0)
      unless absent(up{job="api"})
    `)
    expect(error).toBeUndefined()
    const errors = byName.http_errors_total
    expect(kinds(errors, "code")).toEqual(["filter"])
    expect(kinds(errors, "service")).toEqual(["on"])
    expect(errors.flow.all).toBe(true)
    expect(kinds(byName.up, "job")).toEqual(["filter"])
    expect(byName.up.flow).toEqual({ all: false, only: [] })
  })

  it("keeps raw series flowing, but not through scalar()", () => {
    expect(refsOf("rate(process_cpu_seconds_total[5m])").byName.process_cpu_seconds_total.flow).toEqual({ all: true, except: [] })
    expect(refsOf("scalar(sum(up)) * 2").byName.up.flow).toEqual({ all: false, only: [] })
    expect(refsOf("topk(5, node_load1)").byName.node_load1.flow.all).toBe(true)
    expect(refsOf("count(up == 0)").byName.up.flow).toEqual({ all: false, only: [] })
  })

  it("accepts upper-case keywords and aggregations, and templated offsets", () => {
    const { byName, error } = refsOf(
      'SUM BY (cluster) (kubelet_running_pods{cluster="$cluster"}) OR sum by (cluster) (kubelet_running_pod_count) Unless ON (cluster) kube_node_info'
    )
    expect(error).toBeUndefined()
    // unless binds tighter than or.
    expect(kinds(byName.kubelet_running_pods, "cluster")).toEqual(["variable", "by"])
    expect(kinds(byName.kubelet_running_pod_count, "cluster")).toEqual(["by", "on"])
    expect(kinds(byName.kube_node_info, "cluster")).toEqual(["on"])
    const offset = refsOf('sum(sum_over_time(count by (alertname) (GRAFANA_ALERTS{alertstate="firing"})[${__range_s}s:1m] offset ${__range_s}s)) or vector(0)')
    expect(offset.error).toBeUndefined()
    expect(kinds(offset.byName.GRAFANA_ALERTS, "alertname")).toEqual(["by"])
  })

  it("ignores no-op regex matchers but keeps .+ (which requires the label)", () => {
    const ref = refsOf('rate(x{pod=~".*", instance=~".+"}[1m])').byName.x
    expect(ref.labels.pod).toBeUndefined()
    expect(kinds(ref, "instance")).toEqual(["filter"])
  })

  it("merges repeated uses of one metric and reads recording rule names", () => {
    const { refs } = refsOf("job:http_requests:rate5m{job='a'} / on(job) job:http_requests:rate5m offset 1d")
    expect(refs).toHaveLength(1)
    expect(refs[0].metric).toBe("job:http_requests:rate5m")
    expect(kinds(refs[0], "job")).toEqual(["filter", "on"])
  })

  it("reads quoted UTF-8 metric and label names", () => {
    const ref = refsOf('sum by ("http.route") ({"http.server.duration", "service.name"="api"})').byName["http.server.duration"]
    expect(kinds(ref, "service.name")).toEqual(["filter"])
    expect(kinds(ref, "http.route")).toEqual(["by"])
  })

  it("falls back to a token scan when the parser gives up", () => {
    const { byName, error } = refsOf('sum by (pod) (rate(container_memory_working_set_bytes{namespace="x"}[5m]) $__unknown_macro(3)')
    expect(error).toBeTruthy()
    const ref = byName.container_memory_working_set_bytes
    expect(kinds(ref, "namespace")).toEqual(["filter"])
    expect(kinds(ref, "pod")).toEqual(["by"])
    expect(ref.flow.all).toBe(true)
    expect(refsOf('rate(x{a="unterminated').refs).toEqual([])
    expect(refsOf("").refs).toEqual([])
  })

  it("reads legend labels", () => {
    expect(legendLabels("{{ handler }} {{code}} {{__name__}}")).toEqual(["handler", "code"])
    expect(legendLabels(undefined)).toEqual([])
    // A legend label the query aggregates away isn't a use of it.
    expect(refsOf("sum by (job) (up)", "{{instance}}").byName.up.labels.instance).toBeUndefined()
  })
})
