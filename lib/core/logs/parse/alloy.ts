// Reads `loki.process` stages from Alloy configuration back into log rules.
// A small Alloy syntax reader: blocks, string/number/bool attributes, lists
// and objects, comments, and braces inside strings.

import type { Stage } from "@/lib/core/logs/compile/stages"
import { rulesFromStages, type LogImportResult } from "@/lib/core/logs/parse/stages"

type Token =
  | { type: "ident"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "punct"; value: string }

export type AlloyValue = string | number | boolean | null | AlloyValue[] | { [key: string]: AlloyValue }

export interface AlloyBlock {
  name: string
  label?: string
  attrs: Record<string, AlloyValue>
  blocks: AlloyBlock[]
}

function unquote(literal: string) {
  try {
    return JSON.parse(literal) as string
  } catch {
    return literal.slice(1, -1).replace(/\\(.)/g, "$1")
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) {
      i += 1
    } else if ((char === "/" && text[i + 1] === "/") || char === "#") {
      while (i < text.length && text[i] !== "\n") i += 1
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      tokens.push({ type: "string", value: unquote(text.slice(i, j + 1)) })
      i = j + 1
    } else if (char === "`") {
      const end = text.indexOf("`", i + 1)
      const stop = end === -1 ? text.length : end
      tokens.push({ type: "string", value: text.slice(i + 1, stop) })
      i = stop + 1
    } else if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(text[i + 1] ?? ""))) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(text.slice(i))!
      tokens.push({ type: "number", value: Number(match[0]) })
      i += match[0].length
    } else if (/[A-Za-z_]/.test(char)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j += 1
      tokens.push({ type: "ident", value: text.slice(i, j) })
      i = j
    } else {
      tokens.push({ type: "punct", value: char })
      i += 1
    }
  }
  return tokens
}

class Parser {
  i = 0
  constructor(readonly tokens: Token[]) {}

  peek(offset = 0) {
    return this.tokens[this.i + offset]
  }
  isPunct(value: string, offset = 0) {
    const token = this.peek(offset)
    return token?.type === "punct" && token.value === value
  }

  /** Attributes and blocks until a closing brace (or the end). */
  body(): AlloyBlock {
    const block: AlloyBlock = { name: "", attrs: {}, blocks: [] }
    while (this.i < this.tokens.length && !this.isPunct("}")) {
      const token = this.peek()
      if (token.type === "ident" && this.isPunct("=", 1)) {
        this.i += 2
        block.attrs[token.value] = this.value()
      } else if (token.type === "ident" && (this.isPunct("{", 1) || (this.peek(1)?.type === "string" && this.isPunct("{", 2)))) {
        const label = this.peek(1)?.type === "string" ? (this.peek(1).value as string) : undefined
        this.i += label === undefined ? 2 : 3
        const child = this.body()
        this.i += 1 // "}"
        block.blocks.push({ ...child, name: token.value, label })
      } else {
        this.i += 1
      }
      if (this.isPunct(",")) this.i += 1
    }
    return block
  }

  value(): AlloyValue {
    const token = this.peek()
    if (!token) return null
    if (token.type === "string" || token.type === "number") {
      this.i += 1
      return token.value
    }
    if (token.type === "ident") {
      this.i += 1
      if (token.value === "true" || token.value === "false") return token.value === "true"
      if (token.value === "null") return null
      // A reference (loki.write.default.receiver) or a function call: kept as text.
      if (this.isPunct("(")) this.skipBalanced("(", ")")
      return token.value
    }
    if (token.value === "[") {
      this.i += 1
      const items: AlloyValue[] = []
      while (this.i < this.tokens.length && !this.isPunct("]")) {
        items.push(this.value())
        if (this.isPunct(",")) this.i += 1
      }
      this.i += 1
      return items
    }
    if (token.value === "{") {
      this.i += 1
      const object: Record<string, AlloyValue> = {}
      while (this.i < this.tokens.length && !this.isPunct("}")) {
        const key = this.peek()
        if ((key.type === "ident" || key.type === "string") && (this.isPunct("=", 1) || this.isPunct(":", 1))) {
          this.i += 2
          object[String(key.value)] = this.value()
        } else {
          this.i += 1
        }
        if (this.isPunct(",")) this.i += 1
      }
      this.i += 1
      return object
    }
    this.i += 1
    return null
  }

  skipBalanced(open: string, close: string) {
    let depth = 0
    do {
      if (this.isPunct(open)) depth += 1
      if (this.isPunct(close)) depth -= 1
      this.i += 1
    } while (this.i < this.tokens.length && depth > 0)
  }
}

/** Parses Alloy configuration into a block tree (the root has name ""). */
export function parseAlloyBlocks(text: string): AlloyBlock {
  return new Parser(tokenize(text)).body()
}

const str = (value: AlloyValue | undefined) => (typeof value === "string" ? value : undefined)
const DROP_ATTRS = new Set(["source", "expression", "value", "drop_counter_reason", "separator"])

function toStage(block: AlloyBlock): Stage {
  const kind = block.name.replace(/^stage\./, "")
  const attrs = block.attrs
  switch (kind) {
    case "match":
      return {
        type: "match",
        selector: str(attrs.selector) ?? "",
        ...(str(attrs.action) === "drop" ? { action: "drop" as const } : {}),
        reason: str(attrs.drop_counter_reason),
        stages: stageBlocks(block).map(toStage),
      }
    case "drop": {
      const extra = Object.keys(attrs).filter((key) => !DROP_ATTRS.has(key))
      if (extra.length) return { type: "other", name: `stage.drop with ${extra.join(", ")}` }
      return {
        type: "drop",
        source: str(attrs.source),
        expression: str(attrs.expression),
        value: str(attrs.value),
        reason: str(attrs.drop_counter_reason),
      }
    }
    case "regex":
      return str(attrs.source) ? { type: "other", name: "stage.regex on a source" } : { type: "regex", expression: str(attrs.expression) ?? "" }
    case "sampling":
      return typeof attrs.rate === "number" ? { type: "sampling", rate: attrs.rate } : { type: "other", name: "stage.sampling without a rate" }
    case "label_drop": {
      const values = Array.isArray(attrs.values) ? attrs.values.filter((value): value is string => typeof value === "string") : []
      return { type: "label_drop", labels: values }
    }
    case "structured_metadata": {
      const values = attrs.values && typeof attrs.values === "object" && !Array.isArray(attrs.values) ? attrs.values : {}
      const entries = Object.entries(values)
      if (attrs.regex !== undefined || entries.some(([key, value]) => value !== "" && value !== key && value !== null)) {
        return { type: "other", name: "stage.structured_metadata with a regex or renamed fields" }
      }
      return { type: "structured_metadata", labels: entries.map(([key]) => key) }
    }
    default:
      return { type: "other", name: block.name }
  }
}

function stageBlocks(block: AlloyBlock) {
  return block.blocks.filter((child) => child.name.startsWith("stage."))
}

/** Stages of every `loki.process` component, or top-level stage blocks when none is present. */
export function alloyStages(text: string): Stage[] {
  const root = parseAlloyBlocks(text)
  const components = root.blocks.filter((block) => block.name === "loki.process")
  const blocks = components.length ? components.flatMap(stageBlocks) : stageBlocks(root)
  return blocks.map(toStage)
}

export function parseAlloyLogs(text: string): LogImportResult {
  const stages = alloyStages(text)
  const warnings = stages.length ? [] : ["No loki.process stages found."]
  return rulesFromStages(stages, warnings, text)
}
