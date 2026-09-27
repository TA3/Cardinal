import { describe, expect, it } from "vitest"

import { ease, focusGradient, formatChange, formatSignedPercent, nearestIndex, tooltipLeft, yScaleDomain } from "@/lib/core/chart"

describe("series chart helpers", () => {
  it("formats changes with sign and percent", () => {
    expect(formatChange(12, 12_000)).toBe("+12 (+0.1%)")
    expect(formatChange(-255, 16_102)).toBe("−255 (−1.6%)")
    expect(formatChange(0.2, 100)).toBe("±0")
    expect(formatChange(5, 0)).toBe("+5")
    expect(formatChange(1500, 3000, (value) => `${value / 1000}k`)).toBe("+1.5k (+50.0%)")
    expect(formatSignedPercent(0.001)).toBe("0%")
    expect(formatSignedPercent(Number.NaN)).toBe("0%")
  })

  it("finds the nearest x", () => {
    const xs = [0, 10, 20, 30]
    expect(nearestIndex(xs, -5)).toBe(0)
    expect(nearestIndex(xs, 14)).toBe(1)
    expect(nearestIndex(xs, 16)).toBe(2)
    expect(nearestIndex(xs, 99)).toBe(3)
    expect(nearestIndex([], 3)).toBe(-1)
  })

  it("places the tooltip right, flips near the edge and clamps", () => {
    expect(tooltipLeft({ anchor: 100, width: 200, bounds: 1000 })).toEqual({ left: 112, flipped: false })
    expect(tooltipLeft({ anchor: 900, width: 200, bounds: 1000 })).toEqual({ left: 688, flipped: true })
    // Too narrow to fit on either side: stays inside the margin.
    expect(tooltipLeft({ anchor: 100, width: 300, bounds: 320 }).left).toBe(8)
    expect(tooltipLeft({ anchor: 10, width: 400, bounds: 320 }).left).toBe(8)
  })

  it("mirrors focus gradient stops around --fx", () => {
    const gradient = focusGradient([1, 0.5, "var(--k)", 0], { clear: 40, reach: 100 })
    expect(gradient.startsWith("linear-gradient(to right, rgb(0 0 0 / 0) calc(var(--fx) - 100px)")).toBe(true)
    expect(gradient).toContain("rgb(0 0 0 / 1) calc(var(--fx) - 40px), rgb(0 0 0 / 1) calc(var(--fx) + 40px)")
    expect(gradient).toContain("rgb(0 0 0 / var(--k)) calc(var(--fx) + 80px)")
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBe(0.5)
  })

  it("snaps the y domain to round ticks", () => {
    const { low, high, ticks } = yScaleDomain(15_800, 16_200)
    expect(low).toBeLessThanOrEqual(15_800)
    expect(high).toBeGreaterThanOrEqual(16_200)
    expect(ticks[0]).toBe(low)
    expect(yScaleDomain(0, 10, { yMin: 0 }).low).toBe(0)
  })
})
