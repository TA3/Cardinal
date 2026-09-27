import { describe, expect, it } from "vitest"

import {
  MAX_PATTERN_REGEX,
  patternCoverage,
  patternLineFilter,
  patternMatchesLine,
  patternPreview,
  patternSavings,
  patternSegments,
  patternSpanSeconds,
  patternToRegex,
  rankPatterns,
  sampleAxis,
  sparklineValues,
} from "@/lib/core/logs/patterns"
import { lineRegexProblem, renderLineFilter } from "@/lib/core/logs/selector"
import { regexProblem } from "@/lib/core/regex"

const re = (pattern: string) => patternToRegex(pattern).regex
const matches = patternMatchesLine

describe("patternSegments", () => {
  it("splits literals and placeholders", () => {
    expect(patternSegments("GET <_> 200")).toEqual([
      { text: "GET ", placeholder: false },
      { text: "<_>", placeholder: true },
      { text: " 200", placeholder: false },
    ])
  })

  it("merges adjacent placeholders and handles edges", () => {
    expect(patternSegments("<_><_>x")).toEqual([
      { text: "<_><_>", placeholder: true },
      { text: "x", placeholder: false },
    ])
    expect(patternSegments("")).toEqual([])
    expect(patternSegments("<_>")).toEqual([{ text: "<_>", placeholder: true }])
    expect(patternSegments("a <_")).toEqual([{ text: "a <_", placeholder: false }])
  })
})

describe("patternToRegex", () => {
  it("anchors both ends and turns <_> into a lazy gap", () => {
    expect(re("GET <_> 200")).toBe("^GET\\s+.*?\\s+200$")
  })

  it("drops the anchor at a leading or trailing placeholder", () => {
    expect(re("<_> - - [<_> +0000]")).toBe("\\s+-\\s+-\\s+\\[.*?\\s+\\+0000\\]$")
    expect(re("level=info msg=<_>")).toBe("^level=info\\s+msg=")
    expect(re("<_> done <_>")).toBe("\\s+done\\s+")
  })

  it("collapses adjacent placeholders and whitespace runs", () => {
    expect(re("a<_><_>b")).toBe("^a.*?b$")
    expect(re("a  \t b")).toBe("^a\\s+b$")
  })

  it("turns the pattern's trailing newline into optional whitespace", () => {
    expect(re('{"level":"INFO"}\n')).toBe('^\\{"level":"INFO"\\}\\s*$')
    expect(matches('{"level":"INFO"}\n', '{"level":"INFO"}\n')).toBe(true)
    expect(matches('{"level":"INFO"}\n', '{"level":"INFO"}')).toBe(true)
  })

  it("escapes every regex special", () => {
    const pattern = String.raw`a.b*c+d?e^f$g{1}h(i)j|k[l]m\n`
    const regex = re(pattern)
    expect(regex).toBe(String.raw`^a\.b\*c\+d\?e\^f\$g\{1\}h\(i\)j\|k\[l\]m\\n$`)
    expect(regexProblem(regex)).toBeNull()
    expect(matches(pattern, pattern)).toBe(true)
    expect(matches(pattern, "aXb*c+d?e^f$g{1}h(i)j|k[l]m\\n")).toBe(false)
  })

  it("keeps quotes and slashes literal, and survives LogQL quoting", () => {
    const pattern = `msg="failed" path=/api/<_> user='bob'`
    const regex = re(pattern)
    expect(regex).toBe(`^msg="failed"\\s+path=/api/.*?\\s+user='bob'$`)
    expect(renderLineFilter({ regex })).toBe(` |~ "^msg=\\"failed\\"\\\\s+path=/api/.*?\\\\s+user='bob'$"`)
    expect(matches(pattern, `msg="failed" path=/api/v1/users user='bob'`)).toBe(true)
    expect(matches(pattern, `msg="failed" path=/web/x user='bob'`)).toBe(false)
  })

  it("keeps unicode literal", () => {
    const pattern = "Übermittlung fehlgeschlagen für <_> 🚀 — 完了"
    expect(re(pattern)).toBe("^Übermittlung\\s+fehlgeschlagen\\s+für\\s+.*?\\s+🚀\\s+—\\s+完了$")
    expect(matches(pattern, "Übermittlung fehlgeschlagen für Kunde-42 🚀 — 完了")).toBe(true)
    expect(matches(pattern, "Ubermittlung fehlgeschlagen für x 🚀 — 完了")).toBe(false)
    // NBSP is not RE2 whitespace: it stays literal.
    expect(re("a\u00a0b")).toBe("^a\u00a0b$")
  })

  it("escapes control characters such as ANSI colours", () => {
    const pattern = "\u001b[31mERROR\u001b[0m <_>"
    const regex = re(pattern)
    expect(regex).toBe("^\\x1b\\[31mERROR\\x1b\\[0m\\s+")
    expect(lineRegexProblem(regex)).toBeNull()
    expect(matches(pattern, "\u001b[31mERROR\u001b[0m disk full")).toBe(true)
  })

  it("treats a placeholder glued to a JSON key like Loki does", () => {
    const pattern =
      '{"timestamp":"<_>","level":"INFO","httpRequest":{"url":"<_>","method":"<_>","path":"<_>"},"traceID":"<_>","httpResponse":{"status"<_>,"bytes"<_>,"elapsed"<_>}}\n'
    const line =
      '{"timestamp":"2026-09-26T21:42:26.669973776Z","level":"INFO","httpRequest":{"url":"http://quickpizza-catalog:3333/api/users/token/authenticate","method":"POST","path":"/api/users/token/authenticate"},"traceID":"0cdda994c1e9bb96e8d1b214a3bb93c9","httpResponse":{"status":200,"bytes":57,"elapsed":5.765443}}\n'
    expect(matches(pattern, line)).toBe(true)
    expect(matches(pattern, line.replace('"level":"INFO"', '"level":"ERROR"'))).toBe(false)
  })

  it("matches nginx access lines", () => {
    const pattern = '<_> - - [<_> +0000] "GET /api/tools HTTP/1.1" 200 46 "-" "Grafana Cloud k6" "-"'
    expect(matches(pattern, '10.0.0.1 - - [26/Sep/2026:21:00:00 +0000] "GET /api/tools HTTP/1.1" 200 46 "-" "Grafana Cloud k6" "-"')).toBe(true)
    expect(matches(pattern, '10.0.0.1 - - [26/Sep/2026:21:00:00 +0000] "GET /api/tools HTTP/1.1" 500 46 "-" "Grafana Cloud k6" "-"')).toBe(false)
  })

  it("is not fooled by text that looks like a placeholder or regex", () => {
    expect(matches("value <_ > end", "value <_ > end")).toBe(true)
    expect(matches("x.*y", "xABCy")).toBe(false)
    expect(matches("(a|b)", "a")).toBe(false)
    expect(matches("(a|b)", "(a|b)")).toBe(true)
  })

  it("flags patterns that would match almost anything", () => {
    expect(patternToRegex("<_>")).toMatchObject({ regex: ".*", broad: true })
    expect(patternToRegex("<_> <_>")).toMatchObject({ broad: true })
    expect(patternToRegex("<_> ok <_>")).toMatchObject({ literalChars: 2, broad: true })
    expect(patternToRegex("").broad).toBe(true)
    expect(patternToRegex("GET <_>").broad).toBe(true)
    expect(patternToRegex("POST <_>").broad).toBe(false)
    expect(patternLineFilter("<_>")).toBeNull()
    expect(patternLineFilter("GET <_> 200")).toEqual({ regex: "^GET\\s+.*?\\s+200$" })
  })

  it("truncates long patterns to a prefix match at a token boundary", () => {
    const pattern = `start ${"word(x) ".repeat(120)}<_> end`
    const result = patternToRegex(pattern)
    expect(result.truncated).toBe(true)
    expect(result.regex.length).toBeLessThanOrEqual(MAX_PATTERN_REGEX)
    expect(result.regex.startsWith("^start\\s+word\\(x\\)")).toBe(true)
    expect(result.regex.endsWith("$")).toBe(false)
    expect(result.regex).not.toMatch(/\\s\+$|\.\*\?$|\\$/)
    expect(lineRegexProblem(result.regex)).toBeNull()
    expect(matches(pattern, pattern.replace("<_>", "anything"))).toBe(true)
  })

  // Cases from the stream detail page's former unanchored helper: same lines must match.
  it("matches filled-in patterns and rejects different literals", () => {
    const fill = (pattern: string, value = "x1") => pattern.replace(/<_>/g, value)
    const pattern = 'level=info msg="GET /health <_> 200" duration=<_>'
    const result = patternToRegex(pattern)
    expect(result.truncated).toBe(false)
    expect(result.regex).toBe('^level=info\\s+msg="GET\\s+/health\\s+.*?\\s+200"\\s+duration=')
    expect(new RegExp(result.regex).test(fill(pattern, "13ms"))).toBe(true)
    expect(new RegExp(result.regex).test('level=info msg="GET /api 200" duration=1ms')).toBe(false)
  })

  it("matches JSON lines with or without the pattern's trailing newline", () => {
    const pattern = '{"timestamp":"<_>","level":"INFO","httpRequest":{"url":"<_>","method":"<_>"},"traceID":"<_>"}\n'
    const line = '{"timestamp":"2026-09-26T10:00:00Z","level":"INFO","httpRequest":{"url":"/p","method":"GET"},"traceID":"abc"}'
    expect(matches(pattern, line)).toBe(true)
    expect(matches(pattern, line.replace("INFO", "ERROR"))).toBe(false)
  })

  it("refuses all-placeholder patterns and keeps long ones matching", () => {
    expect(patternLineFilter("<_> <_>")).toBeNull()
    const long = Array.from({ length: 80 }, (_, index) => `word${index} <_>`).join(" ")
    const result = patternToRegex(long)
    expect(result.truncated).toBe(true)
    expect(result.regex.length).toBeLessThanOrEqual(MAX_PATTERN_REGEX)
    expect(matches(long, long.replace(/<_>/g, "x1"))).toBe(true)
  })

  it("never cuts an escape in half", () => {
    for (let max = 5; max < 40; max++) {
      const { regex } = patternToRegex("[[[[.... ]]]] (((( ))))", { maxLength: max })
      expect(regexProblem(regex === "" ? ".*" : regex)).toBeNull()
    }
  })
})

describe("pattern ranking and savings", () => {
  const patterns = [
    { pattern: "b <_>", count: 25, samples: [] },
    { pattern: "a <_>", count: 75, samples: [] },
  ]

  it("ranks by count with line shares and byte estimates", () => {
    const rows = rankPatterns(patterns, { bytesPerDay: 1000 })
    expect(rows.map((row) => [row.pattern, row.share, row.lineShare, row.bytesPerDay])).toEqual([
      ["a <_>", 0.75, 0.75, 750],
      ["b <_>", 0.25, 0.25, 250],
    ])
    expect(rankPatterns(patterns)[0].bytesPerDay).toBeNull()
    expect(rankPatterns([{ pattern: "x", count: 0, samples: [] }], { bytesPerDay: 10 })[0].share).toBe(0)
  })

  it("trusts the pattern mix only when it covers enough of the service's lines", () => {
    // 100 of 400 lines: 25% coverage, the mix stands.
    expect(patternCoverage(patterns, 400)).toBe(0.25)
    expect(rankPatterns(patterns, { lines: 400, bytesPerDay: 1000 })[0].lineShare).toBe(0.75)
    // 100 of 10,000 lines: 1% coverage, shares fall back to count / lines.
    const low = rankPatterns(patterns, { lines: 10_000, bytesPerDay: 1000 })
    expect(low.map((row) => [row.share, row.lineShare, row.bytesPerDay])).toEqual([
      [0.75, 0.0075, 7.5],
      [0.25, 0.0025, 2.5],
    ])
    expect(patternCoverage(patterns, 50)).toBe(1)
    expect(patternCoverage(patterns, 0)).toBeNull()
    expect(patternCoverage(patterns, null)).toBeNull()
  })

  it("saves bytes × (1 − keep)", () => {
    expect(patternSavings(1000, 0)).toBe(1000)
    expect(patternSavings(1000, 0.1)).toBe(900)
    expect(patternSavings(1000, 2)).toBe(0)
    expect(patternSavings(-5, 0)).toBe(0)
  })

  it("measures the span samples cover and builds sparklines", () => {
    const items = [
      { samples: [{ t: 0, count: 1 }, { t: 60_000, count: 2 }] },
      { samples: [{ t: 120_000, count: 3 }] },
    ]
    expect(patternSpanSeconds(items)).toBe(180)
    expect(patternSpanSeconds([{ samples: [] }])).toBeNull()
    const axis = sampleAxis(items)
    expect(axis).toEqual([0, 60_000, 120_000])
    expect(sparklineValues(items[0].samples, axis)).toEqual([1, 2, 0])
  })

  it("previews patterns on one line", () => {
    expect(patternPreview("a\n  b\t<_>\n")).toBe("a b <_>")
    expect(patternPreview("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`)
  })
})
