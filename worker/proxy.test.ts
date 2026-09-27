import { describe, expect, it } from "vitest"

import { isAllowedPath } from "./proxy"

describe("proxy allowlist", () => {
  it("allows Prometheus and Loki reads", () => {
    expect(isAllowedPath("GET", "/api/v1/query")).toBe(true)
    expect(isAllowedPath("POST", "/api/v1/query_range")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/index/volume_range")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/label/service_name/values")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/query_range")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/status/buildinfo")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/rules")).toBe(true)
    expect(isAllowedPath("GET", "/loki/api/v1/push")).toBe(false)
    expect(isAllowedPath("POST", "/loki/api/v1/rules")).toBe(false)
    expect(isAllowedPath("DELETE", "/loki/api/v1/labels")).toBe(false)
  })

  it("allows listing Grafana data sources, GET only", () => {
    expect(isAllowedPath("GET", "/api/datasources")).toBe(true)
    expect(isAllowedPath("POST", "/api/datasources")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/1")).toBe(false)
  })

  it("allows creating a Grafana dashboard: POST /api/dashboards/db only", () => {
    expect(isAllowedPath("POST", "/api/dashboards/db")).toBe(true)
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect(isAllowedPath(method, "/api/dashboards/db")).toBe(false)
    expect(isAllowedPath("POST", "/api/dashboards/db/")).toBe(false)
    expect(isAllowedPath("POST", "/api/dashboards/import")).toBe(false)
    expect(isAllowedPath("POST", "/api/dashboards/uid/abc")).toBe(false)
    expect(isAllowedPath("DELETE", "/api/dashboards/uid/abc")).toBe(false)
    expect(isAllowedPath("POST", "/api/datasources/proxy/uid/x/api/dashboards/db")).toBe(false)
  })

  it("allows only Prometheus and Loki reads through the data source proxy", () => {
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/labels")).toBe(true)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/ac4000ca-1959-45f5-aa45-2bd0898f7026/loki/api/v1/index/stats")).toBe(true)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query")).toBe(true)
    expect(isAllowedPath("POST", "/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/x/api/v1/admin/tsdb/delete_series")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/a.b/loki/api/v1/labels")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/a%2Fb/loki/api/v1/labels")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/../../admin/loki/api/v1/labels")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/x/y/loki/api/v1/labels")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/x/loki/api/v1/labels/extra")).toBe(false)
  })

  it("allows Loki's rules API, GET only, directly and through the data source proxy", () => {
    expect(isAllowedPath("GET", "/prometheus/api/v1/rules")).toBe(true)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/grafanacloud-logs/prometheus/api/v1/rules")).toBe(true)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/rules")).toBe(true)
    expect(isAllowedPath("POST", "/prometheus/api/v1/rules")).toBe(false)
    expect(isAllowedPath("DELETE", "/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/rules")).toBe(false)
    expect(isAllowedPath("GET", "/loki/api/v1/rules/namespace")).toBe(false)
  })

  it("allows Adaptive Logs reads, and writes only to drop rules and exemptions", () => {
    for (const path of ["recommendations", "drop-rules", "exemptions", "expiring-exemptions", "segments"]) {
      expect(isAllowedPath("GET", `/adaptive-logs/${path}`)).toBe(true)
    }
    expect(isAllowedPath("POST", "/adaptive-logs/drop-rules")).toBe(true)
    expect(isAllowedPath("POST", "/adaptive-logs/exemptions")).toBe(true)
    expect(isAllowedPath("POST", "/adaptive-logs/expiring-exemptions")).toBe(true)
    expect(isAllowedPath("PUT", "/adaptive-logs/drop-rules/0b1c-9f_A")).toBe(true)
    expect(isAllowedPath("DELETE", "/adaptive-logs/drop-rules/0b1c-9f_A")).toBe(true)
    expect(isAllowedPath("GET", "/adaptive-logs/exemptions/abc123")).toBe(true)
    expect(isAllowedPath("PUT", "/adaptive-logs/exemptions/abc123")).toBe(true)
    expect(isAllowedPath("DELETE", "/adaptive-logs/exemptions/abc123")).toBe(true)

    expect(isAllowedPath("POST", "/adaptive-logs/recommendations")).toBe(false)
    expect(isAllowedPath("POST", "/adaptive-logs/segments")).toBe(false)
    expect(isAllowedPath("POST", "/adaptive-logs/segment")).toBe(false)
    expect(isAllowedPath("DELETE", "/adaptive-logs/segment")).toBe(false)
    expect(isAllowedPath("PUT", "/adaptive-logs/drop-rules")).toBe(false)
    expect(isAllowedPath("DELETE", "/adaptive-logs/exemptions")).toBe(false)
    expect(isAllowedPath("DELETE", "/adaptive-logs/recommendations/x")).toBe(false)
    expect(isAllowedPath("PUT", "/adaptive-logs/drop-rules/a.b")).toBe(false)
    expect(isAllowedPath("DELETE", "/adaptive-logs/drop-rules/a%2F..%2Fx")).toBe(false)
    expect(isAllowedPath("DELETE", "/adaptive-logs/drop-rules/x/y")).toBe(false)
    expect(isAllowedPath("GET", "/api/datasources/proxy/uid/grafanacloud-logs/adaptive-logs/recommendations")).toBe(false)
  })

  it("rejects encoded slashes and dot segments", () => {
    expect(isAllowedPath("GET", "/loki/api/v1/label/a%2F..%2F..%2Fx/values")).toBe(false)
    expect(isAllowedPath("GET", "/loki/api/v1/label/../values")).toBe(false)
  })
})
