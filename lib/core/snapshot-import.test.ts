import { describe, expect, it } from "vitest"

import { parseSnapshotRows, snapshotCurl, snapshotFromImport, SNAPSHOT_QUERY } from "@/lib/core/snapshot-import"

const response = {
  status: "success",
  data: {
    resultType: "vector",
    result: [
      { metric: { __name__: "http_requests_total", job: "api" }, value: [1, "1200"] },
      { metric: { __name__: "http_requests_total", job: "web" }, value: [1, "300"] },
      { metric: { __name__: "up" }, value: [1, "4"] },
    ],
  },
}

describe("pasted snapshots", () => {
  it("reads Prometheus' query response", () => {
    expect(parseSnapshotRows(JSON.stringify(response))).toEqual([
      { job: "api", metric: "http_requests_total", seriesCount: 1200 },
      { job: "web", metric: "http_requests_total", seriesCount: 300 },
      { job: "", metric: "up", seriesCount: 4 },
    ])
  })

  it("reads the bare result array and Grafana's CSV download", () => {
    expect(parseSnapshotRows(JSON.stringify(response.data.result))).toHaveLength(3)
    const csv = '"Time","__name__","job","Value"\n2026-10-27 10:00:00,http_requests_total,api,1200\n2026-10-27 10:00:00,"up","",4\n'
    expect(parseSnapshotRows(csv)).toEqual([
      { job: "api", metric: "http_requests_total", seriesCount: 1200 },
      { job: "", metric: "up", seriesCount: 4 },
    ])
  })

  it("explains results it can't use", () => {
    expect(() => parseSnapshotRows("")).toThrow(/Paste/)
    expect(() => parseSnapshotRows("{ nope")).toThrow(/valid JSON/)
    expect(() => parseSnapshotRows(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } }))).toThrow(/instant query/)
    expect(() => parseSnapshotRows(JSON.stringify({ status: "error", error: "query timed out" }))).toThrow(/timed out/)
    expect(() => parseSnapshotRows(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1, "2"] }] } }))).toThrow(
      /__name__/
    )
    // A row it can't read stops the import rather than undercounting.
    expect(() => parseSnapshotRows('"__name__","job","Value"\nup,api,4\nhttp_requests_total,api,12.3 K\n')).toThrow(/Formatted data/)
    expect(() =>
      parseSnapshotRows(JSON.stringify([{ metric: { __name__: "up" }, value: [1, "4"] }, { metric: { __name__: "x" }, value: [1, "NaN?"] }]))
    ).toThrow(/numeric/)
  })

  it("builds a snapshot marked as imported", () => {
    const snapshot = snapshotFromImport(JSON.stringify(response), 20)
    expect(snapshot.method).toBe("import")
    expect(snapshot.totalSeries).toBe(1504)
    expect(snapshot.labelCount).toBeNull()
    expect(snapshot.seriesByMetricJob?.http_requests_total).toEqual({ api: 1200, web: 300 })
  })

  it("gives a runnable curl command", () => {
    expect(snapshotCurl("https://prom.example/")).toBe(
      `curl -sG 'https://prom.example/api/v1/query' --data-urlencode 'query=${SNAPSHOT_QUERY}' > snapshot.json`
    )
  })
})
