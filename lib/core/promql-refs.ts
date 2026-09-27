// Which metrics a PromQL expression reads and how it uses each metric's labels,
// for dashboard and alert usage evidence. Tolerant by design: Grafana template
// variables are neutralised first, and an expression the parser can't follow
// falls back to a token scan (label flow then unknown, so every label counts as
// shown).

export type LabelUseKind =
  | "filter"
  | "by"
  | "without"
  | "on"
  | "ignoring"
  | "group_left"
  | "group_right"
  | "label_replace"
  | "label_join"
  | "histogram_quantile"
  | "sort"
  | "legend"
  | "variable"

export interface LabelUse {
  kind: LabelUseKind
  /** How the query uses it, for people: `by (handler)`, `pod=~"$pod"`. */
  text: string
}

/** Uses that survive dropping the label: the query removes it anyway. */
export const HARMLESS_USES: ReadonlySet<LabelUseKind> = new Set(["without", "ignoring"])

/**
 * Labels whose values reach the result (shown in a panel, or used to match):
 * every label except some, or only some. A panel plotting `rate(x[5m])` shows
 * every label of x; `sum by (job) (…)` only job.
 */
export type LabelFlow = { all: true; except: string[] } | { all: false; only: string[] }

export interface MetricRef {
  /** Exact metric name; absent for pattern refs. */
  metric?: string
  /** RE2 pattern from `{__name__=~"…"}`, or a name built from template variables. */
  pattern?: string
  /** Labels used explicitly, with how. */
  labels: Record<string, LabelUse[]>
  flow: LabelFlow
}

export interface PromqlRefs {
  refs: MetricRef[]
  /** Set when the parser gave up and a token scan found the refs instead. */
  error?: string
}

// ---------------------------------------------------------------------------
// Tokenizer

type TokenType = "ident" | "tident" | "var" | "number" | "string" | "op" | "(" | ")" | "{" | "}" | "," | "range" | "eof"

interface Token {
  type: TokenType
  value: string
  pos: number
}

const IDENT_START = /[A-Za-z_:]/
const IDENT_PART = /[A-Za-z0-9_:]/
const DURATION = /^(\d+(\.\d+)?(ms|s|m|h|d|w|y))+/
const NUMBER = /^(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/
const OPERATORS = ["==", "!=", ">=", "<=", "=~", "!~", "=", ">", "<", "+", "-", "*", "/", "%", "^", "@"]

/** `[[var]]` (Grafana's old syntax) becomes `$var`, so `[` only ever opens a range. */
export function neutralizeTemplateVariables(expr: string) {
  return expr.replace(/\[\[([A-Za-z0-9_.:]+)\]\]/g, (_, name: string) => `$${name}`)
}

class ParseError extends Error {}

function readVariable(text: string, start: number): number {
  // start is at "$"
  if (text[start + 1] === "{") {
    const close = text.indexOf("}", start + 2)
    if (close < 0) throw new ParseError(`unterminated variable at ${start}`)
    return close + 1
  }
  let end = start + 1
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1
  if (end === start + 1) throw new ParseError(`stray $ at ${start}`)
  return end
}

function readString(text: string, start: number): { value: string; end: number } {
  const quote = text[start]
  let value = ""
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === quote) return { value, end: index + 1 }
    if (char === "\\" && quote !== "`" && index + 1 < text.length) {
      const next = text[index + 1]
      value += next === "n" ? "\n" : next === "t" ? "\t" : next
      index += 2
      continue
    }
    value += char
    index += 1
  }
  throw new ParseError(`unterminated string at ${start}`)
}

export function tokenize(expr: string): Token[] {
  const text = neutralizeTemplateVariables(expr)
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "[") {
      // A range or subquery: its contents (durations, $__rate_interval) don't matter.
      let depth = 0
      let end = index
      for (; end < text.length; end += 1) {
        if (text[end] === "[") depth += 1
        else if (text[end] === "]" && --depth === 0) break
      }
      if (end >= text.length) throw new ParseError(`unterminated range at ${index}`)
      tokens.push({ type: "range", value: text.slice(index, end + 1), pos: index })
      index = end + 1
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      const { value, end } = readString(text, index)
      tokens.push({ type: "string", value, pos: index })
      index = end
      continue
    }
    if ("(){},".includes(char)) {
      tokens.push({ type: char as TokenType, value: char, pos: index })
      index += 1
      continue
    }
    if (/[0-9.]/.test(char) && /[0-9]/.test(text[index + (char === "." ? 1 : 0)] ?? "")) {
      const rest = text.slice(index)
      const match = rest.match(DURATION) ?? rest.match(NUMBER)
      if (match) {
        tokens.push({ type: "number", value: match[0], pos: index })
        index += match[0].length
        continue
      }
    }
    if (IDENT_START.test(char) || char === "$") {
      // Identifiers may be glued to variables: node_${suffix}_total.
      let end = index
      let parts = ""
      let pattern = ""
      let hasVariable = false
      while (end < text.length) {
        if (text[end] === "$") {
          const after = readVariable(text, end)
          hasVariable = true
          parts += text.slice(end, after)
          pattern += ".*"
          end = after
        } else if (IDENT_PART.test(text[end]) && (end > index || IDENT_START.test(text[end]))) {
          parts += text[end]
          pattern += text[end]
          end += 1
        } else break
      }
      // Keywords (and, OR, BY…) are case-insensitive in PromQL.
      if (!hasVariable && KEYWORDS.has(parts.toLowerCase())) parts = parts.toLowerCase()
      const onlyVariable = hasVariable && /^\$(\{[^}]*\}|[A-Za-z0-9_]+)$/.test(parts)
      tokens.push({ type: onlyVariable ? "var" : hasVariable ? "tident" : "ident", value: hasVariable && !onlyVariable ? pattern : parts, pos: index })
      index = end
      continue
    }
    const operator = OPERATORS.find((op) => text.startsWith(op, index))
    if (operator) {
      tokens.push({ type: "op", value: operator, pos: index })
      index += operator.length
      continue
    }
    throw new ParseError(`unexpected ${JSON.stringify(char)} at ${index}`)
  }
  tokens.push({ type: "eof", value: "", pos: text.length })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (a Pratt parser for the parts of PromQL that matter for labels)

interface Matcher {
  label: string
  op: string
  value: string
}

type Node =
  | { type: "sel"; metric?: string; pattern?: string; matchers: Matcher[] }
  | { type: "lit"; str?: string }
  | { type: "call"; name: string; args: Node[] }
  | { type: "agg"; op: string; grouping?: Grouping; args: Node[] }
  | { type: "bin"; op: string; lhs: Node; rhs: Node; match?: Grouping; group?: { side: "left" | "right"; labels: string[] } }

interface Grouping {
  kind: "by" | "without" | "on" | "ignoring"
  labels: string[]
  /** A template variable in the list: the grouping can't be known. */
  dynamic: boolean
}

const AGGREGATIONS = new Set([
  "sum",
  "min",
  "max",
  "avg",
  "group",
  "stddev",
  "stdvar",
  "count",
  "count_values",
  "bottomk",
  "topk",
  "quantile",
  "limitk",
  "limit_ratio",
])
/** Aggregations that return input series as they are (with all their labels). */
const SELECTING_AGGREGATIONS = new Set(["topk", "bottomk", "limitk", "limit_ratio"])
const KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right", "bool", "offset", "and", "or", "unless", "atan2"])
const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  unless: 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
  atan2: 5,
  "^": 6,
}

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]
  }

  private next() {
    const token = this.peek()
    if (token.type !== "eof") this.index += 1
    return token
  }

  private expect(type: TokenType) {
    const token = this.next()
    if (token.type !== type) throw new ParseError(`expected ${type} at ${token.pos}, got ${token.value || token.type}`)
    return token
  }

  parse(): Node {
    const node = this.expression(0)
    if (this.peek().type !== "eof") throw new ParseError(`unexpected ${this.peek().value} at ${this.peek().pos}`)
    return node
  }

  private binaryOperator(): string | null {
    const token = this.peek()
    if (token.type === "op" && token.value in PRECEDENCE) return token.value
    if (token.type === "ident" && ["and", "or", "unless", "atan2"].includes(token.value)) return token.value
    return null
  }

  private expression(minPrecedence: number): Node {
    let lhs = this.unary()
    for (;;) {
      const op = this.binaryOperator()
      if (!op || PRECEDENCE[op] < minPrecedence) return lhs
      this.next()
      if (this.peek().type === "ident" && this.peek().value === "bool") this.next()
      let match: Grouping | undefined
      let group: { side: "left" | "right"; labels: string[] } | undefined
      if (this.peek().type === "ident" && (this.peek().value === "on" || this.peek().value === "ignoring")) {
        const kind = this.next().value as "on" | "ignoring"
        match = { kind, ...this.labelList() }
        if (this.peek().type === "ident" && (this.peek().value === "group_left" || this.peek().value === "group_right")) {
          const side = this.next().value === "group_left" ? "left" : "right"
          group = { side, labels: this.peek().type === "(" ? this.labelList().labels : [] }
        }
      }
      // ^ is right-associative; everything else left.
      const rhs = this.expression(op === "^" ? PRECEDENCE[op] : PRECEDENCE[op] + 1)
      lhs = { type: "bin", op, lhs, rhs, match, group }
    }
  }

  private unary(): Node {
    const token = this.peek()
    if (token.type === "op" && (token.value === "-" || token.value === "+")) {
      this.next()
      return this.unary()
    }
    return this.postfix(this.primary())
  }

  private postfix(node: Node): Node {
    for (;;) {
      const token = this.peek()
      if (token.type === "range") {
        this.next()
      } else if (token.type === "ident" && token.value === "offset") {
        this.next()
        if (this.peek().type === "op" && this.peek().value === "-") this.next()
        const amount = this.next()
        // Durations may come from variables: offset ${__range_s}s.
        if (amount.type !== "number" && amount.type !== "var" && amount.type !== "tident") throw new ParseError(`bad offset at ${amount.pos}`)
      } else if (token.type === "op" && token.value === "@") {
        this.next()
        const at = this.next()
        if (at.type === "ident" && this.peek().type === "(") {
          this.expect("(")
          this.expect(")")
        } else if (at.type !== "number" && at.type !== "var" && at.type !== "tident") throw new ParseError(`bad @ modifier at ${at.pos}`)
      } else return node
    }
  }

  private labelList(): { labels: string[]; dynamic: boolean } {
    this.expect("(")
    const labels: string[] = []
    let dynamic = false
    while (this.peek().type !== ")") {
      const token = this.next()
      if (token.type === "ident" || token.type === "string") labels.push(token.value)
      else if (token.type === "var" || token.type === "tident") dynamic = true
      else throw new ParseError(`expected a label at ${token.pos}`)
      if (this.peek().type === ",") this.next()
      else if (this.peek().type !== ")") throw new ParseError(`expected , or ) at ${this.peek().pos}`)
    }
    this.expect(")")
    return { labels, dynamic }
  }

  private args(): Node[] {
    this.expect("(")
    const args: Node[] = []
    while (this.peek().type !== ")") {
      args.push(this.expression(0))
      if (this.peek().type === ",") this.next()
      else if (this.peek().type !== ")") throw new ParseError(`expected , or ) at ${this.peek().pos}`)
    }
    this.expect(")")
    return args
  }

  private selector(metric?: string, pattern?: string): Node {
    const matchers: Matcher[] = []
    if (this.peek().type === "{") {
      this.next()
      while (this.peek().type !== "}") {
        const name = this.next()
        if (name.type === "var" || name.type === "tident") {
          // A whole matcher from a variable (ad hoc filters): skip what follows it.
          if (this.peek().type === "op") {
            this.next()
            this.next()
          }
        } else if (name.type !== "ident" && name.type !== "string") {
          throw new ParseError(`expected a label at ${name.pos}`)
        } else if (this.peek().type === "op" && ["=", "!=", "=~", "!~"].includes(this.peek().value)) {
          const op = this.next().value
          const value = this.next()
          if (value.type !== "string" && value.type !== "var") throw new ParseError(`expected a string at ${value.pos}`)
          matchers.push({ label: name.value, op, value: value.value })
        } else if (name.type === "string" && metric === undefined && matchers.length === 0) {
          metric = name.value // {"utf8.metric.name", …}
        } else throw new ParseError(`expected a matcher operator at ${this.peek().pos}`)
        if (this.peek().type === ",") this.next()
        else if (this.peek().type !== "}") throw new ParseError(`expected , or } at ${this.peek().pos}`)
      }
      this.expect("}")
    }
    for (const matcher of matchers) {
      if (matcher.label !== "__name__") continue
      if (matcher.op === "=") metric ??= matcher.value
      else if (matcher.op === "=~") pattern ??= matcher.value
    }
    return { type: "sel", metric, pattern: metric === undefined ? pattern : undefined, matchers }
  }

  private primary(): Node {
    const token = this.peek()
    switch (token.type) {
      case "(": {
        this.next()
        const inner = this.expression(0)
        this.expect(")")
        return inner
      }
      case "number":
        this.next()
        return { type: "lit" }
      case "string":
        this.next()
        return { type: "lit", str: token.value }
      case "var":
        this.next()
        return { type: "lit" }
      case "{":
        return this.selector()
      case "tident":
        this.next()
        return this.selector(undefined, token.value)
      case "ident": {
        const name = token.value
        const after = this.peek(1)
        if (AGGREGATIONS.has(name.toLowerCase()) && (after.type === "(" || (after.type === "ident" && (after.value === "by" || after.value === "without")))) {
          return this.aggregation()
        }
        if (after.type === "(") {
          this.next()
          return { type: "call", name, args: this.args() }
        }
        if (/^(inf|nan)$/i.test(name)) {
          this.next()
          return { type: "lit" }
        }
        if (KEYWORDS.has(name)) throw new ParseError(`unexpected ${name} at ${token.pos}`)
        this.next()
        return this.selector(name)
      }
      default:
        throw new ParseError(`unexpected ${token.value || token.type} at ${token.pos}`)
    }
  }

  private aggregation(): Node {
    const op = this.next().value.toLowerCase()
    let grouping: Grouping | undefined
    const readGrouping = () => {
      const token = this.peek()
      if (token.type === "ident" && (token.value === "by" || token.value === "without")) {
        this.next()
        grouping = { kind: token.value, ...this.labelList() }
      }
    }
    readGrouping()
    const args = this.args()
    if (!grouping) readGrouping()
    return { type: "agg", op, grouping, args }
  }
}

// ---------------------------------------------------------------------------
// Label flow analysis

/** Labels that flow on: all except `set`, or only `set`. */
interface Pass {
  all: boolean
  set: Set<string>
}

interface Accumulator {
  metric?: string
  pattern?: string
  labels: Map<string, LabelUse[]>
  flow: Pass
}

interface Source {
  acc: Accumulator
  pass: Pass
}

const passes = (pass: Pass, label: string) => (pass.all ? !pass.set.has(label) : pass.set.has(label))
const keepOnly = (pass: Pass, labels: Iterable<string>): Pass => {
  const wanted = new Set(labels)
  return { all: false, set: new Set([...wanted].filter((label) => passes(pass, label))) }
}
const remove = (pass: Pass, labels: Iterable<string>): Pass =>
  pass.all ? { all: true, set: new Set([...pass.set, ...labels]) } : { all: false, set: new Set([...pass.set].filter((label) => ![...labels].includes(label))) }
const NOTHING: Pass = { all: false, set: new Set() }

function unionPass(a: Pass, b: Pass): Pass {
  if (a.all && b.all) return { all: true, set: new Set([...a.set].filter((label) => b.set.has(label))) }
  if (a.all) return { all: true, set: new Set([...a.set].filter((label) => !b.set.has(label))) }
  if (b.all) return unionPass(b, a)
  return { all: false, set: new Set([...a.set, ...b.set]) }
}

function record(acc: Accumulator, label: string, use: LabelUse) {
  if (label === "__name__") return
  const list = acc.labels.get(label) ?? []
  if (!list.some((item) => item.kind === use.kind && item.text === use.text)) list.push(use)
  acc.labels.set(label, list)
}

/** Records a use on each source whose series still carry the label. */
function recordFlowing(sources: Source[], label: string, kind: LabelUseKind, text = `${kind} (${label})`) {
  for (const source of sources) if (passes(source.pass, label)) record(source.acc, label, { kind, text })
}

const mapPass = (sources: Source[], fn: (pass: Pass) => Pass) => sources.map((source) => ({ ...source, pass: fn(source.pass) }))
const stringArg = (node: Node | undefined) => (node?.type === "lit" ? node.str : undefined)

function shorten(value: string, max = 40) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Filters that match every series, with or without the label, say nothing about it. */
function isNoopMatcher(matcher: Matcher) {
  return matcher.op === "=~" && (matcher.value === ".*" || matcher.value === "")
}

class Analyzer {
  readonly accumulators: Accumulator[] = []

  evaluate(node: Node): Source[] {
    switch (node.type) {
      case "lit":
        return []
      case "sel": {
        const acc: Accumulator = { metric: node.metric, pattern: node.pattern, labels: new Map(), flow: NOTHING }
        for (const matcher of node.matchers) {
          if (isNoopMatcher(matcher)) continue
          const variable = /\$/.test(matcher.value)
          record(acc, matcher.label, {
            kind: variable ? "variable" : "filter",
            text: `${matcher.label}${matcher.op}"${shorten(matcher.value)}"`,
          })
        }
        if (node.metric === undefined && node.pattern === undefined) return []
        this.accumulators.push(acc)
        return [{ acc, pass: { all: true, set: new Set() } }]
      }
      case "call":
        return this.call(node.name, node.args)
      case "agg": {
        const sources = node.args.flatMap((arg) => this.evaluate(arg))
        const grouping = node.grouping
        const selecting = SELECTING_AGGREGATIONS.has(node.op)
        if (!grouping) return selecting ? sources : mapPass(sources, () => NOTHING)
        for (const label of grouping.labels) recordFlowing(sources, label, grouping.kind === "without" ? "without" : "by")
        if (selecting || grouping.dynamic) return sources
        return mapPass(sources, (pass) => (grouping.kind === "by" ? keepOnly(pass, grouping.labels) : remove(pass, grouping.labels)))
      }
      case "bin":
        return this.binary(node)
    }
  }

  private call(name: string, args: Node[]): Source[] {
    switch (name) {
      case "histogram_quantile": {
        const sources = args.slice(1).flatMap((arg) => this.evaluate(arg))
        args.slice(0, 1).forEach((arg) => this.evaluate(arg))
        recordFlowing(sources, "le", "histogram_quantile", "histogram_quantile")
        return mapPass(sources, (pass) => remove(pass, ["le"]))
      }
      case "label_replace": {
        const sources = this.evaluate(args[0] ?? { type: "lit" })
        const source = stringArg(args[3])
        if (source) recordFlowing(sources, source, "label_replace", `label_replace (${source})`)
        return sources
      }
      case "label_join": {
        const sources = this.evaluate(args[0] ?? { type: "lit" })
        for (const arg of args.slice(3)) {
          const source = stringArg(arg)
          if (source) recordFlowing(sources, source, "label_join", `label_join (${source})`)
        }
        return sources
      }
      case "sort_by_label":
      case "sort_by_label_desc": {
        const sources = this.evaluate(args[0] ?? { type: "lit" })
        for (const arg of args.slice(1)) {
          const label = stringArg(arg)
          if (label) recordFlowing(sources, label, "sort", `${name} (${label})`)
        }
        return sources
      }
      case "absent":
      case "absent_over_time":
      case "scalar":
        args.forEach((arg) => this.evaluate(arg))
        return []
      default:
        return args.flatMap((arg) => this.evaluate(arg))
    }
  }

  private binary(node: Extract<Node, { type: "bin" }>): Source[] {
    const lhs = this.evaluate(node.lhs)
    const rhs = this.evaluate(node.rhs)
    if (!lhs.length || !rhs.length) return [...lhs, ...rhs]
    const { match, group } = node
    if (match) for (const label of match.labels) recordFlowing([...lhs, ...rhs], label, match.kind === "on" ? "on" : "ignoring")
    if (group) {
      const one = group.side === "left" ? rhs : lhs
      for (const label of group.labels) recordFlowing(one, label, group.side === "left" ? "group_left" : "group_right")
    }
    if (node.op === "or") return [...lhs, ...rhs]
    // Matching labels (all, when no on/ignoring) decide the result, so they count as used.
    const matched = (sources: Source[], extra: string[] = []) =>
      !match || match.dynamic ? sources : mapPass(sources, (pass) => (match.kind === "on" ? keepOnly(pass, [...match.labels, ...extra]) : remove(pass, match.labels)))
    if (node.op === "and" || node.op === "unless") return [...lhs, ...matched(rhs)]
    if (group) return group.side === "left" ? [...lhs, ...matched(rhs, group.labels)] : [...matched(lhs, group.labels), ...rhs]
    return [...matched(lhs), ...matched(rhs)]
  }
}

// ---------------------------------------------------------------------------
// Fallback: a token scan for expressions the parser can't follow

function scanTokens(tokens: Token[], accumulators: Accumulator[]) {
  const grouped: Array<{ label: string; kind: LabelUseKind }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (token.type === "ident" && next?.type === "(" && ["by", "without", "on", "ignoring", "group_left", "group_right"].includes(token.value)) {
      index += 2
      while (index < tokens.length && tokens[index].type !== ")") {
        if (tokens[index].type === "ident" || tokens[index].type === "string") grouped.push({ label: tokens[index].value, kind: token.value as LabelUseKind })
        index += 1
      }
      continue
    }
    const startsSelector = (token.type === "ident" && !KEYWORDS.has(token.value) && next?.type !== "(" && !AGGREGATIONS.has(token.value)) || token.type === "tident" || token.type === "{"
    if (!startsSelector || (token.type === "ident" && /^(inf|nan)$/i.test(token.value))) continue
    const acc: Accumulator = { labels: new Map(), flow: { all: true, set: new Set() } }
    if (token.type === "ident") acc.metric = token.value
    if (token.type === "tident") acc.pattern = token.value
    let cursor = token.type === "{" ? index : index + 1
    if (tokens[cursor]?.type === "{") {
      cursor += 1
      while (cursor < tokens.length && tokens[cursor].type !== "}") {
        const [name, op, value] = [tokens[cursor], tokens[cursor + 1], tokens[cursor + 2]]
        if (name && op?.type === "op" && value && (value.type === "string" || value.type === "var")) {
          const matcher = { label: name.value, op: op.value, value: value.value }
          if (matcher.label === "__name__" && matcher.op === "=") acc.metric ??= matcher.value
          else if (matcher.label === "__name__" && matcher.op === "=~") acc.pattern ??= matcher.value
          else if (!isNoopMatcher(matcher)) {
            record(acc, matcher.label, {
              kind: /\$/.test(matcher.value) ? "variable" : "filter",
              text: `${matcher.label}${matcher.op}"${shorten(matcher.value)}"`,
            })
          }
          cursor += 3
        } else cursor += 1
      }
      index = cursor
    }
    if (acc.metric !== undefined) acc.pattern = undefined
    if (acc.metric !== undefined || acc.pattern !== undefined) accumulators.push(acc)
  }
  for (const acc of accumulators) for (const { label, kind } of grouped) record(acc, label, { kind, text: `${kind} (${label})` })
}

// ---------------------------------------------------------------------------

/** `{{handler}} on {{ instance }}` → handler, instance. */
export function legendLabels(legend: string | undefined): string[] {
  if (!legend) return []
  return Array.from(new Set(Array.from(legend.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g), (match) => match[1]))).filter(
    (label) => label !== "__name__"
  )
}

/** A catch-all name pattern (`.+`, `.*`) matches every metric and says nothing about any one. */
function isCatchAll(pattern: string) {
  return /^(\.[*+])+$/.test(pattern.trim())
}

function mergeAccumulators(accumulators: Accumulator[]): MetricRef[] {
  const merged = new Map<string, Accumulator>()
  for (const acc of accumulators) {
    if (acc.pattern !== undefined && isCatchAll(acc.pattern)) continue
    const key = acc.metric !== undefined ? `m:${acc.metric}` : `p:${acc.pattern}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...acc, labels: new Map(Array.from(acc.labels, ([label, uses]) => [label, [...uses]])) })
      continue
    }
    for (const [label, uses] of acc.labels) for (const use of uses) record(existing, label, use)
    existing.flow = unionPass(existing.flow, acc.flow)
  }
  return Array.from(merged.values()).map((acc) => ({
    ...(acc.metric !== undefined ? { metric: acc.metric } : { pattern: acc.pattern }),
    labels: Object.fromEntries(Array.from(acc.labels).sort(([a], [b]) => a.localeCompare(b))),
    flow: acc.flow.all ? { all: true, except: [...acc.flow.set].sort() } : { all: false, only: [...acc.flow.set].sort() },
  }))
}

/**
 * Metrics an expression reads, with how it uses their labels. `legend` is a
 * Grafana legend format; its `{{label}}` references count as uses.
 */
export function extractPromqlRefs(expr: string, options: { legend?: string } = {}): PromqlRefs {
  let tokens: Token[]
  try {
    tokens = tokenize(expr)
  } catch (error) {
    return { refs: [], error: error instanceof Error ? error.message : String(error) }
  }
  if (tokens.length === 1) return { refs: [] }
  try {
    const tree = new Parser(tokens).parse()
    const analyzer = new Analyzer()
    const roots = analyzer.evaluate(tree)
    for (const label of legendLabels(options.legend)) recordFlowing(roots, label, "legend", `{{${label}}}`)
    for (const root of roots) root.acc.flow = unionPass(root.acc.flow, root.pass)
    return { refs: mergeAccumulators(analyzer.accumulators) }
  } catch (error) {
    const accumulators: Accumulator[] = []
    scanTokens(tokens, accumulators)
    for (const label of legendLabels(options.legend)) for (const acc of accumulators) record(acc, label, { kind: "legend", text: `{{${label}}}` })
    return { refs: mergeAccumulators(accumulators), error: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether a flow lets the label through. */
export function flowIncludes(flow: LabelFlow, label: string) {
  return flow.all ? !flow.except.includes(label) : flow.only.includes(label)
}
