import { describe, expect, it } from "vitest"

import { formatBytes, formatBytesDelta, toGB } from "@/lib/core/bytes"
import { anyValueSelector, isLokiLabelName, logQueries, logqlDuration, matchesEmpty, quoteLogQLValue, streamSelector } from "@/lib/core/logql"

describe("logql", () => {
  it("builds selectors with escaped values", () => {
    expect(streamSelector([{ label: "service_name", op: "=", value: "api" }])).toBe('{service_name="api"}')
    expect(streamSelector({ matchers: [{ label: "a", op: "=", value: 'x"} |= "y' }] })).toBe('{a="x\\"} |= \\"y"}')
    expect(quoteLogQLValue("a\\b\nc\td\u0001")).toBe('"a\\\\b\\nc\\td\\x01"')
    expect(anyValueSelector("job")).toBe('{job=~".+"}')
  })

  it("validates label names, operators and regexes", () => {
    expect(isLokiLabelName("service_name")).toBe(true)
    expect(isLokiLabelName("9x")).toBe(false)
    expect(() => streamSelector([{ label: "a b", op: "=", value: "x" }])).toThrow(/label name/)
    expect(() => streamSelector([{ label: "a", op: "==" as "=", value: "x" }])).toThrow(/operator/)
    expect(() => streamSelector([{ label: "a", op: "=~", value: "(a" }])).toThrow(/regex/)
    expect(() => streamSelector([{ label: "a", op: "=~", value: "(?=x)" }])).toThrow(/RE2/)
  })

  it("refuses selectors that only match empty values", () => {
    expect(() => streamSelector([])).toThrow(/at least one/)
    expect(() => streamSelector([{ label: "a", op: "=", value: "" }])).toThrow(/empty/)
    expect(() => streamSelector([{ label: "a", op: "=~", value: ".*" }])).toThrow(/empty/)
    expect(() => streamSelector([{ label: "a", op: "!=", value: "x" }])).toThrow(/empty/)
    expect(streamSelector([{ label: "a", op: "!=", value: "x" }, { label: "b", op: "=~", value: "y|z" }])).toBe('{a!="x", b=~"y|z"}')
    expect(matchesEmpty({ label: "a", op: "=~", value: ".+" })).toBe(false)
  })

  it("renders metric queries and durations", () => {
    expect(logqlDuration(3600)).toBe("1h")
    expect(logqlDuration(86400 * 7)).toBe("7d")
    expect(logqlDuration(90)).toBe("90s")
    expect(logqlDuration(600)).toBe("10m")
    expect(logQueries.bytesOverTime([{ label: "job", op: "=", value: "x" }], 3600, ["level"])).toBe('sum by (level) (bytes_over_time({job="x"}[1h]))')
    expect(logQueries.countOverTime([{ label: "job", op: "=", value: "x" }], 300)).toBe('sum (count_over_time({job="x"}[5m]))')
    expect(() => logQueries.bytesOverTime([{ label: "job", op: "=", value: "x" }], 60, ["bad label"])).toThrow(/label name/)
  })
})

describe("bytes", () => {
  it("formats 1024-based sizes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1,023 B")
    expect(formatBytes(1024)).toBe("1.00 KB")
    expect(formatBytes(1536)).toBe("1.50 KB")
    expect(formatBytes(18886436787)).toBe("17.6 GB")
    expect(formatBytes(1024 ** 4 * 250)).toBe("250 TB")
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.00 MB")
    expect(formatBytes(-2048)).toBe("−2.00 KB")
    expect(formatBytesDelta(1024 ** 3)).toBe("+1.00 GB")
    expect(toGB(1024 ** 3 * 3)).toBe(3)
  })
})
