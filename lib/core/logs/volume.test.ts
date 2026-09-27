import { describe, expect, it } from "vitest"

import {
  bytesByValue,
  compareVolumes,
  formatGrowth,
  growthPercent,
  perDay,
  streamChange,
  topGrowers,
  topVolumeSeries,
  volumePeriods,
  volumeTotals,
} from "@/lib/core/logs/volume"

describe("volume periods", () => {
  it("aligns the end and puts the previous period right before", () => {
    const { current, previous } = volumePeriods("1h", 3_600_000 * 10 + 59_999, 60)
    expect(current).toEqual({ start: 3_600_000 * 9, end: 3_600_000 * 10 })
    expect(previous).toEqual({ start: 3_600_000 * 8, end: 3_600_000 * 9 })
    expect(volumePeriods("7d", 1e13).current.end - volumePeriods("7d", 1e13).current.start).toBe(7 * 86_400_000)
  })

  it("scales bytes to a day", () => {
    expect(perDay(100, "1h")).toBe(2400)
    expect(perDay(700, "7d")).toBe(100)
  })
})

describe("bytesByValue", () => {
  it("merges rows per value and keeps streams without the label as ''", () => {
    const rows: Array<{ labels: Record<string, string>; bytes: number }> = [
      { labels: { app: "a" }, bytes: 10 },
      { labels: { app: "a", pod: "x" }, bytes: 5 },
      { labels: { pod: "y" }, bytes: 3 },
      { labels: { app: "b" }, bytes: Number.NaN },
    ]
    expect(bytesByValue(rows, "app")).toEqual([
      { value: "a", bytes: 15 },
      { value: "", bytes: 3 },
      { value: "b", bytes: 0 },
    ])
  })
})

describe("compareVolumes", () => {
  const current = [
    { value: "api", bytes: 600 },
    { value: "web", bytes: 300 },
    { value: "new", bytes: 100 },
  ]
  const previous = [
    { value: "api", bytes: 400 },
    { value: "web", bytes: 302 },
    { value: "old", bytes: 50 },
  ]

  it("ranks by bytes with shares, deltas and trends; gone values last", () => {
    const rows = compareVolumes(current, previous)
    expect(rows.map((row) => [row.value, row.share, row.delta, row.trend, row.grower])).toEqual([
      ["api", 60, 200, "up", true],
      ["web", 30, -2, "flat", false],
      ["new", 10, 100, "new", true],
      ["old", 0, -50, "gone", false],
    ])
    expect(rows[0].growth).toBe(50)
    expect(rows[2].growth).toBeNull()
  })

  it("knows nothing about trends without a previous period", () => {
    const rows = compareVolumes(current, null)
    expect(rows.every((row) => row.trend === "unknown" && row.delta === null && !row.grower)).toBe(true)
  })

  it("ignores growth that is small in percent or in bytes", () => {
    const rows = compareVolumes(
      [
        { value: "big", bytes: 1_000_000 },
        { value: "tiny", bytes: 20 },
        { value: "slow", bytes: 105_000 },
      ],
      [
        { value: "big", bytes: 1_000_000 },
        { value: "tiny", bytes: 1 },
        { value: "slow", bytes: 100_000 },
      ]
    )
    expect(rows.filter((row) => row.grower)).toEqual([])
    expect(rows.find((row) => row.value === "slow")!.trend).toBe("up")
    expect(rows.find((row) => row.value === "big")!.trend).toBe("flat")
  })

  it("lists the top growers by bytes gained", () => {
    const growers = topGrowers(compareVolumes(current, previous))
    expect(growers.map((row) => row.value)).toEqual(["api", "new"])
    expect(topGrowers(compareVolumes(current, previous), 1).map((row) => row.value)).toEqual(["api"])
  })
})

describe("volume totals and growth", () => {
  it("compares totals, but not against an empty previous period", () => {
    expect(volumeTotals([{ value: "a", bytes: 150 }], [{ value: "a", bytes: 100 }])).toEqual({ bytes: 150, previousBytes: 100, delta: 50, growth: 50 })
    expect(volumeTotals([{ value: "a", bytes: 150 }], [])).toEqual({ bytes: 150, previousBytes: null, delta: null, growth: null })
    expect(volumeTotals([{ value: "a", bytes: 150 }], null).delta).toBeNull()
  })

  it("computes and formats growth", () => {
    expect(growthPercent(0, 5)).toBeNull()
    expect(growthPercent(200, 100)).toBe(-50)
    expect(formatGrowth(12.345)).toBe("+12%")
    expect(formatGrowth(-3.44)).toBe("−3.4%")
    expect(formatGrowth(1234.5)).toBe("+1,235%")
    expect(formatGrowth(0.01)).toBe("0%")
    expect(formatGrowth(null)).toBe("—")
    expect(formatGrowth(null, "new")).toBe("new")
    expect(formatGrowth(-100, "gone")).toBe("gone")
  })

  it("compares stream counts", () => {
    expect(streamChange(120, 100)).toEqual({ delta: 20, growth: 20 })
    expect(streamChange(120, 0)).toEqual({ delta: null, growth: null })
    expect(streamChange(120, null).delta).toBeNull()
  })
})

describe("topVolumeSeries", () => {
  const series: Array<{ labels: Record<string, string>; points: Array<{ t: number; value: number }> }> = [
    { labels: { app: "a" }, points: [{ t: 1, value: 10 }, { t: 2, value: 10 }, { t: 3, value: 99 }] },
    { labels: { app: "b" }, points: [{ t: 1, value: 1 }, { t: 2, value: 1 }] },
    { labels: { app: "c" }, points: [{ t: 2, value: 5 }] },
    { labels: { app: "a", pod: "2" }, points: [{ t: 1, value: 1 }] },
  ]

  it("keeps the largest values, fills gaps with 0 and drops the open bucket", () => {
    const top = topVolumeSeries(series, "app", { limit: 2, dropFrom: 3 })
    expect(top.keys).toEqual(["a", "c"])
    expect(top.points).toEqual([
      { t: 1, values: { a: 11, c: 0 } },
      { t: 2, values: { a: 10, c: 5 } },
    ])
  })

  it("drops the first bucket too", () => {
    expect(topVolumeSeries(series, "app", { limit: 1, dropBefore: 2 }).points).toEqual([
      { t: 2, values: { a: 10 } },
      { t: 3, values: { a: 99 } },
    ])
  })

  it("returns nothing for empty input", () => {
    expect(topVolumeSeries([], "app")).toEqual({ keys: [], points: [] })
  })
})
