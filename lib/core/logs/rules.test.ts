import { describe, expect, it } from "vitest"

import {
  activateOrCreateLogRule,
  createLogRule,
  describeLogRule,
  foldLogRules,
  isLogRuleShadowed,
  logRuleKey,
  logRuleProblem,
  logRuleSelector,
  logRuleShadowedBy,
  mergeLogRules,
  toggleLogRule,
  type LogRuleInput,
} from "@/lib/core/logs/rules"
import {
  levelLineRegex,
  levelsFromLineRegex,
  lineFilterFromParsed,
  matcherProblem,
  parseLogSelector,
  renderLogSelector,
  renderSelector,
  selectorContains,
  selectorProblem,
  selectorsDisjoint,
} from "@/lib/core/logs/selector"
import type { LabelMatcher, LogRule, StreamSelector } from "@/lib/core/logs/types"

const sel = (...matchers: Array<[string, LabelMatcher["op"], string]>): StreamSelector => ({
  matchers: matchers.map(([label, op, value]) => ({ label, op, value })),
})
const api = sel(["service_name", "=", "api"])

function rule(input: Partial<LogRuleInput> & Pick<LogRuleInput, "kind">): LogRule {
  const defaults = { selector: api, origin: "user" as const }
  return createLogRule({ ...defaults, ...input } as LogRuleInput)
}

describe("log selectors", () => {
  it("validates label names, operators and values", () => {
    expect(matcherProblem({ label: "app", op: "=", value: "x" })).toBeNull()
    expect(matcherProblem({ label: "1app", op: "=", value: "x" })).toMatch(/label name/)
    expect(matcherProblem({ label: "app}", op: "=", value: "x" })).toMatch(/label name/)
    expect(matcherProblem({ label: "app", op: "==" as never, value: "x" })).toMatch(/operator/)
    expect(matcherProblem({ label: "app", op: "=", value: "a\nb" })).toMatch(/control/)
    expect(matcherProblem({ label: "app", op: "=", value: "a\u0000" })).toMatch(/control/)
    expect(matcherProblem({ label: "app", op: "=~", value: "(a" })).toMatch(/regex/)
    expect(matcherProblem({ label: "app", op: "=~", value: "(?=x)" })).toMatch(/RE2/)
    expect(matcherProblem({ label: "app", op: "=", value: "x".repeat(2000) })).toMatch(/longer/)
  })

  it("requires one matcher that needs a non-empty value", () => {
    expect(selectorProblem(api)).toBeNull()
    expect(selectorProblem(sel())).toMatch(/at least one/)
    expect(selectorProblem(sel(), { allowEmpty: true })).toBeNull()
    expect(selectorProblem(sel(["app", "!=", "x"]))).toMatch(/non-empty/)
    expect(selectorProblem(sel(["app", "=~", ".*"]))).toMatch(/non-empty/)
    expect(selectorProblem(sel(["app", "=", ""]))).toMatch(/non-empty/)
    expect(selectorProblem(sel(["app", "=~", ".+"]))).toBeNull()
  })

  it("escapes quotes, backslashes and regex specials when rendering", () => {
    expect(renderSelector(sel(["app", "=", 'say "hi"\\now']))).toBe('{app="say \\"hi\\"\\\\now"}')
    expect(renderSelector(sel(["path", "=~", "/api/v1/.+\\.json"]))).toBe('{path=~"/api/v1/.+\\\\.json"}')
    expect(() => renderSelector(sel(["app", "=", "x\n}"]))).toThrow(/control/)
    expect(() => renderSelector(sel(["app\"", "=", "x"]))).toThrow(/label name/)
    expect(renderSelector(sel(), sel(["service_name", "=~", ".+"]))).toBe('{service_name=~".+"}')
  })

  it("renders line filters", () => {
    expect(renderLogSelector(api, { regex: 'GET /health "ok"' })).toBe('{service_name="api"} |~ "GET /health \\"ok\\""')
    expect(renderLogSelector(api, { levels: ["debug"] })).toContain("|~ ")
    expect(() => renderLogSelector(api, { regex: "a\nb" })).toThrow()
    expect(() => renderLogSelector(api, { regex: "x", levels: ["debug"] })).toThrow(/either/)
  })

  it("parses what it renders, including escapes", () => {
    const original = sel(["app", "=", 'q"\\x'], ["path", "=~", "/a/.+\\.js"], ["env", "!=", "dev"], ["x", "!~", "a|b"])
    const parsed = parseLogSelector(renderLogSelector(original, { regex: 'lit "q" \\d+' }))
    expect(parsed.selector).toEqual(original)
    expect(parsed.filters).toEqual([{ op: "|~", value: 'lit "q" \\d+' }])
    expect(parsed.rest).toBe("")
  })

  it("parses raw strings, trailing commas and pipeline rest", () => {
    const parsed = parseLogSelector('{ app = `a\\b`, } |= "x" | json')
    expect(parsed.selector.matchers).toEqual([{ label: "app", op: "=", value: "a\\b" }])
    expect(parsed.filters).toEqual([{ op: "|=", value: "x" }])
    expect(parsed.rest).toBe("| json")
    expect(() => parseLogSelector('{app="x"')).toThrow()
    expect(() => parseLogSelector("app")).toThrow()
  })

  it("maps parsed line filters to one rule filter", () => {
    expect(lineFilterFromParsed([{ op: "|=", value: "a.b" }])).toEqual({ line: { regex: "a\\.b" } })
    expect(lineFilterFromParsed([{ op: "|~", value: levelLineRegex(["trace", "debug"]) }])).toEqual({
      line: { levels: ["debug", "trace"] },
    })
    expect(lineFilterFromParsed([{ op: "!=", value: "x" }]).problem).toMatch(/negative/)
    expect(lineFilterFromParsed([{ op: "|=", value: "x" }, { op: "|=", value: "y" }]).problem).toMatch(/more than one/)
    expect(levelsFromLineRegex("level=debug")).toBeNull()
  })

  it("decides containment exactly for = and conservatively for regexes", () => {
    const broad = sel(["namespace", "=", "prod"])
    const narrow = sel(["namespace", "=", "prod"], ["app", "=", "api"])
    expect(selectorContains(broad, narrow)).toBe(true)
    expect(selectorContains(narrow, broad)).toBe(false)
    expect(selectorContains(sel(), narrow)).toBe(true)
    // Regex outer: literal inner values are tested against it.
    expect(selectorContains(sel(["app", "=~", "api|web"]), sel(["app", "=", "api"]))).toBe(true)
    expect(selectorContains(sel(["app", "=~", "api.*"]), sel(["app", "=~", "api-v1|api-v2"]))).toBe(true)
    expect(selectorContains(sel(["app", "=~", "api|web"]), sel(["app", "=", "db"]))).toBe(false)
    // Non-literal regexes only contain the identical matcher.
    expect(selectorContains(sel(["app", "=~", "api.*"]), sel(["app", "=~", "api.*"]))).toBe(true)
    expect(selectorContains(sel(["app", "=~", ".+"]), sel(["app", "=~", "api.*"]))).toBe(false)
    // Negative matchers.
    expect(selectorContains(sel(["env", "!=", "dev"]), sel(["env", "=", "prod"]))).toBe(true)
    expect(selectorContains(sel(["env", "!=", "dev"]), sel(["env", "=", "dev"]))).toBe(false)
    expect(selectorContains(sel(["env", "!~", "dev|test"]), sel(["env", "=~", "prod|stage"]))).toBe(true)
    expect(selectorContains(sel(["env", "!=", ""]), sel(["env", "=~", ".+"]))).toBe(true)
    // .* matches streams without the label too.
    expect(selectorContains(sel(["app", "=~", ".*"], ["env", "=", "x"]), sel(["env", "=", "x"]))).toBe(true)
  })

  it("proves disjointness only from literal values", () => {
    expect(selectorsDisjoint(sel(["app", "=", "a"]), sel(["app", "=", "b"]))).toBe(true)
    expect(selectorsDisjoint(sel(["app", "=", "a"]), sel(["app", "=~", "b|c"]))).toBe(true)
    expect(selectorsDisjoint(sel(["app", "=", "a"]), sel(["app", "!=", "a"]))).toBe(true)
    expect(selectorsDisjoint(sel(["app", "=", "a"]), sel(["env", "=", "b"]))).toBe(false)
    expect(selectorsDisjoint(sel(["app", "=", "a"]), sel(["app", "=~", "a.*"]))).toBe(false)
  })
})

describe("log rules", () => {
  it("creates every kind with normalized fields", () => {
    const streams = rule({ kind: "drop_streams", selector: sel(["b", "=", "2"], ["a", "=", "1"], ["a", "=", "1"]) })
    expect(streams.selector.matchers.map((m) => m.label)).toEqual(["a", "b"])
    expect(streams.status).toBe("active")
    expect(streams.id).toMatch(/^[0-9a-f-]{36}$/)
    const lines = rule({ kind: "drop_lines", line: { levels: ["TRACE", "debug", "debug"] } })
    expect(lines.kind === "drop_lines" && lines.line).toEqual({ levels: ["debug", "trace"] })
    const sample = rule({ kind: "sample", keep: 0.1, status: "proposed" })
    expect(sample.status).toBe("proposed")
    expect(rule({ kind: "drop_label", label: "pod" }).kind).toBe("drop_label")
    expect(rule({ kind: "label_to_metadata", label: "trace_id" }).kind).toBe("label_to_metadata")
    expect(rule({ kind: "retention", days: 7 }).kind).toBe("retention")
  })

  it("rejects invalid rules", () => {
    const bad = (input: Partial<LogRuleInput> & Pick<LogRuleInput, "kind">) =>
      logRuleProblem({ selector: api, origin: "user", ...input } as LogRuleInput)
    expect(bad({ kind: "drop_streams", selector: sel() })).toMatch(/selector/)
    expect(bad({ kind: "drop_lines", selector: sel(), line: { regex: "x" } })).toBeNull()
    expect(bad({ kind: "drop_lines", line: {} })).toMatch(/either/)
    expect(bad({ kind: "drop_lines", line: { regex: "(?<=x)" } })).toMatch(/RE2/)
    expect(bad({ kind: "drop_lines", line: { regex: "(?i)health" } })).toBeNull()
    expect(bad({ kind: "drop_lines", line: { levels: ["de bug"] } })).toMatch(/level/)
    expect(bad({ kind: "drop_lines", line: { levels: ['x"'] } })).toMatch(/level/)
    expect(bad({ kind: "sample", keep: 0 })).toMatch(/keep/)
    expect(bad({ kind: "sample", keep: 1 })).toMatch(/keep/)
    expect(bad({ kind: "sample", keep: Number.NaN })).toMatch(/keep/)
    expect(bad({ kind: "drop_label", label: "bad-label" })).toMatch(/label/)
    expect(bad({ kind: "drop_label", label: "__name__" })).toMatch(/internal/)
    expect(bad({ kind: "drop_label", label: "service_name" })).toMatch(/selector uses/)
    expect(bad({ kind: "label_to_metadata", selector: sel(["app", "=", "x"]), label: "service_name" })).toMatch(/stay/)
    expect(bad({ kind: "retention", days: 0.5 })).toMatch(/days/)
    expect(bad({ kind: "retention", selector: sel(), days: 3 })).toMatch(/selector/)
    expect(bad({ kind: "nope" as never })).toMatch(/unknown kind/)
    expect(() => rule({ kind: "sample", keep: 2 })).toThrow(/Invalid log rule/)
  })

  it("keys on kind, canonical selector and filter or label, not settings", () => {
    const a = rule({ kind: "sample", selector: sel(["b", "=", "2"], ["a", "=", "1"]), keep: 0.1 })
    const b = rule({ kind: "sample", selector: sel(["a", "=", "1"], ["b", "=", "2"]), keep: 0.5 })
    expect(logRuleKey(a)).toBe(logRuleKey(b))
    expect(logRuleKey(rule({ kind: "drop_label", label: "pod" }))).not.toBe(logRuleKey(rule({ kind: "drop_label", label: "node" })))
    expect(logRuleKey(rule({ kind: "drop_lines", line: { regex: "a" } }))).not.toBe(
      logRuleKey(rule({ kind: "drop_lines", line: { regex: "b" } }))
    )
  })

  it("merges within a status only, keeping the stronger setting", () => {
    const active = rule({ kind: "sample", keep: 0.5 })
    const stronger = rule({ kind: "sample", keep: 0.1 })
    const weaker = rule({ kind: "sample", keep: 0.8 })
    const merged = mergeLogRules([active], [stronger, weaker])
    expect(merged.rules).toHaveLength(1)
    expect(merged.rules[0].id).toBe(active.id)
    expect(merged.rules[0].kind === "sample" && merged.rules[0].keep).toBe(0.1)
    expect(merged.added).toEqual([stronger])
    expect(merged.skipped).toEqual([weaker])

    const retention = mergeLogRules([rule({ kind: "retention", days: 14 })], [rule({ kind: "retention", days: 7 })])
    expect(retention.rules[0].kind === "retention" && retention.rules[0].days).toBe(7)
  })

  it("skips proposals an active rule covers but keeps other statuses apart", () => {
    const active = rule({ kind: "drop_label", label: "pod" })
    const proposal = rule({ kind: "drop_label", label: "pod", status: "proposed" })
    expect(mergeLogRules([active], [proposal]).skipped).toEqual([proposal])
    // A proposed stronger sample is not covered by a weaker active one: it stays for review.
    const activeSample = rule({ kind: "sample", keep: 0.5 })
    const proposedSample = rule({ kind: "sample", keep: 0.1, status: "proposed" })
    const result = mergeLogRules([activeSample], [proposedSample])
    expect(result.rules).toHaveLength(2)
    expect(result.rules[0]).toBe(activeSample)
    // Rejected rules don't absorb new active ones.
    const rejected = rule({ kind: "drop_streams", status: "rejected" })
    expect(mergeLogRules([rejected], [rule({ kind: "drop_streams" })]).rules).toHaveLength(2)
    // Exact duplicates are skipped.
    expect(mergeLogRules([active], [rule({ kind: "drop_label", label: "pod" })]).skipped).toHaveLength(1)
  })

  it("activates or creates, updating keep and days", () => {
    const proposed = rule({ kind: "sample", keep: 0.5, status: "proposed" })
    const next = activateOrCreateLogRule([proposed], { kind: "sample", selector: api, keep: 0.2, origin: "user" })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: proposed.id, status: "active", keep: 0.2 })
    const created = activateOrCreateLogRule([], { kind: "drop_streams", selector: api, origin: "agent" })
    expect(created[0]).toMatchObject({ kind: "drop_streams", status: "active", origin: "agent" })
    const same = activateOrCreateLogRule(created, { kind: "drop_streams", selector: api, origin: "user" })
    expect(same).toBe(created)
    expect(() => activateOrCreateLogRule([proposed], { kind: "sample", selector: api, keep: 3, origin: "user" })).toThrow()
  })

  it("toggles rules on and off", () => {
    const candidate: LogRuleInput = { kind: "drop_label", selector: api, label: "pod", origin: "user" }
    const on = toggleLogRule([], candidate)
    expect(on).toHaveLength(1)
    expect(toggleLogRule(on, candidate)).toHaveLength(0)
  })

  it("folds rules that end up with the same key and status", () => {
    const a = rule({ kind: "retention", days: 30 })
    const b = { ...rule({ kind: "retention", days: 7, status: "proposed" }), status: "active" as const }
    const folded = foldLogRules([a, b])
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ id: a.id, days: 7 })
  })

  it("shadows narrower rules under an active drop_streams", () => {
    const broad = rule({ kind: "drop_streams", selector: sel(["namespace", "=", "dev"]) })
    const narrowDrop = rule({ kind: "drop_streams", selector: sel(["namespace", "=", "dev"], ["app", "=", "x"]) })
    const lines = rule({ kind: "drop_lines", selector: sel(["namespace", "=", "dev"], ["app", "=", "x"]), line: { regex: "a" } })
    const label = rule({ kind: "drop_label", selector: sel(["namespace", "=", "dev"]), label: "pod" })
    const other = rule({ kind: "drop_label", selector: sel(["namespace", "=", "prod"]), label: "pod" })
    const all = [broad, narrowDrop, lines, label, other]
    expect(logRuleShadowedBy(narrowDrop, all)).toBe(broad)
    expect(logRuleShadowedBy(lines, all)).toBe(broad)
    expect(logRuleShadowedBy(label, all)).toBe(broad)
    expect(isLogRuleShadowed(other, all)).toBe(false)
    expect(isLogRuleShadowed(broad, all)).toBe(false)
    // Proposed rules never shadow.
    expect(isLogRuleShadowed(lines, [{ ...broad, status: "proposed" }, lines])).toBe(false)
  })

  it("breaks ties between identical drops by order", () => {
    const first = rule({ kind: "drop_streams" })
    const second = rule({ kind: "drop_streams" })
    expect(isLogRuleShadowed(first, [first, second])).toBe(false)
    expect(isLogRuleShadowed(second, [first, second])).toBe(true)
  })

  it("shadows samples and narrower drops of the same lines under a drop_lines", () => {
    const drop = rule({ kind: "drop_lines", selector: sel(["namespace", "=", "dev"]), line: { levels: ["debug"] } })
    const sample = rule({ kind: "sample", selector: sel(["namespace", "=", "dev"], ["app", "=", "x"]), line: { levels: ["debug"] }, keep: 0.1 })
    const otherLines = rule({ kind: "sample", selector: sel(["namespace", "=", "dev"]), line: { levels: ["info"] }, keep: 0.1 })
    expect(logRuleShadowedBy(sample, [drop, sample])).toBe(drop)
    expect(isLogRuleShadowed(otherLines, [drop, otherLines])).toBe(false)
  })

  it("describes every kind", () => {
    expect(describeLogRule(rule({ kind: "drop_streams" }))).toBe('Drop streams {service_name="api"}')
    expect(describeLogRule(rule({ kind: "drop_lines", line: { levels: ["debug", "trace"] } }))).toBe(
      'Drop debug, trace lines in {service_name="api"}'
    )
    expect(describeLogRule(rule({ kind: "drop_lines", selector: sel(), line: { regex: "health" } }))).toBe(
      "Drop lines matching /health/ in all streams"
    )
    expect(describeLogRule(rule({ kind: "sample", keep: 0.1 }))).toBe('Keep 10% of lines in {service_name="api"}')
    expect(describeLogRule(rule({ kind: "sample", keep: 0.005 }))).toContain("0.50%")
    expect(describeLogRule(rule({ kind: "drop_label", label: "pod" }))).toBe('Drop label pod from {service_name="api"}')
    expect(describeLogRule(rule({ kind: "label_to_metadata", label: "trace_id" }))).toContain("structured metadata")
    expect(describeLogRule(rule({ kind: "retention", days: 1 }))).toBe('Keep {service_name="api"} for 1 day')
    expect(logRuleSelector(rule({ kind: "drop_lines", line: { regex: "x" } }))).toBe('{service_name="api"} |~ "x"')
  })
})
