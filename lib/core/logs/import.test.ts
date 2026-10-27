import { describe, expect, it } from "vitest"

import { logsBytesQuery, logsCurl, logsSnapshotFromImport, logsStreamsQuery, parseLabelVector } from "@/lib/core/logs/import"

const vector = (rows: Array<[string, string]>, label = "service_name") =>
  JSON.stringify({ status: "success", data: { resultType: "vector", result: rows.map(([value, amount]) => ({ metric: { [label]: value }, value: [1, amount] })) } })

describe("pasted logs snapshots", () => {
  it("builds the snapshot from bytes and stream counts per service", () => {
    const snapshot = logsSnapshotFromImport({
      range: "24h",
      bytes: vector([
        ["checkout", "3000000000"],
        ["api", "1000000000"],
      ]),
      streams: vector([
        ["checkout", "40"],
        ["api", "12"],
      ]),
    })
    expect(snapshot.imported).toBe(true)
    expect(snapshot.groupLabel).toBe("service_name")
    expect(snapshot.selector).toBe('{service_name=~".+"}')
    expect(snapshot.totals).toMatchObject({ bytes: 4_000_000_000, streams: 52 })
    expect(snapshot.groups.map((group) => [group.value, group.streams, group.share])).toEqual([
      ["checkout", 40, 75],
      ["api", 12, 25],
    ])
  })

  it("works without the streams result", () => {
    const snapshot = logsSnapshotFromImport({ range: "1h", bytes: vector([["api", "10"]], "app") })
    expect(snapshot.groupLabel).toBe("app")
    expect(snapshot.totals.streams).toBe(0)
  })

  it("reads Grafana's CSV download", () => {
    const csv = '"Time","service_name","Value #A"\n2026-10-27 10:00:00,checkout,300\n2026-10-27 10:00:00,api,100\n'
    expect(parseLabelVector(csv)).toEqual({
      label: "service_name",
      rows: [
        { value: "checkout", amount: 300 },
        { value: "api", amount: 100 },
      ],
    })
  })

  it("explains results it can't use", () => {
    expect(() => parseLabelVector("")).toThrow(/Paste/)
    expect(() => parseLabelVector(JSON.stringify({ status: "success", data: { resultType: "streams", result: [] } }))).toThrow(/instant query/)
    expect(() => parseLabelVector(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }))).toThrow(/empty/)
    expect(() =>
      parseLabelVector(JSON.stringify([{ metric: { service_name: "a", job: "b" }, value: [1, "2"] }]))
    ).toThrow(/exactly one label/)
    expect(() => parseLabelVector('"service_name","Value"\napi,1.2 GB\n')).toThrow(/Formatted data/)
    expect(() => logsSnapshotFromImport({ range: "24h", bytes: vector([["a", "1"]]), streams: vector([["a", "1"]], "app") })).toThrow(/different labels/)
  })

  it("gives runnable queries", () => {
    expect(logsBytesQuery("24h")).toBe('sum by (service_name) (bytes_over_time({service_name=~".+"}[24h]))')
    expect(logsStreamsQuery("7d", "app")).toBe('count by (app) (count_over_time({app=~".+"}[7d]))')
    expect(logsCurl("x", "https://loki.example/")).toBe("curl -sG 'https://loki.example/loki/api/v1/query' --data-urlencode 'query=x'")
  })
})
