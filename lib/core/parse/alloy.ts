import { rulesFromRelabel, type ImportResult, type RawRelabelRule } from "@/lib/core/parse/relabel"

// Minimal Alloy syntax reader: enough to find `rule { ... }` blocks and their
// string / string-list attributes. Handles comments and braces inside strings.

type Token =
  | { type: "ident"; value: string }
  | { type: "string"; value: string }
  | { type: "punct"; value: string }

function unquote(literal: string) {
  try {
    return JSON.parse(literal) as string
  } catch {
    // Go escapes JSON lacks (\a, \v, \', \x..); keep the escaped char.
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
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
    } else if (char === "#") {
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

function readRuleBlock(tokens: Token[], start: number): { raw: RawRelabelRule; end: number } {
  const attrs: Record<string, string | string[]> = {}
  let i = start
  let depth = 1
  while (i < tokens.length && depth > 0) {
    const token = tokens[i]
    if (token.type === "punct" && token.value === "{") depth += 1
    if (token.type === "punct" && token.value === "}") depth -= 1
    if (depth === 1 && token.type === "ident" && tokens[i + 1]?.value === "=") {
      const value = tokens[i + 2]
      if (value?.type === "string") {
        attrs[token.value] = value.value
        i += 3
        continue
      }
      if (value?.type === "punct" && value.value === "[") {
        const list: string[] = []
        let j = i + 3
        while (j < tokens.length && tokens[j].value !== "]") {
          const item = tokens[j]
          if (item.type === "string") list.push(item.value)
          j += 1
        }
        attrs[token.value] = list
        i = j + 1
        continue
      }
    }
    i += 1
  }

  const str = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : undefined)
  return {
    raw: {
      sourceLabels: Array.isArray(attrs.source_labels) ? attrs.source_labels : [],
      separator: str("separator"),
      action: str("action"),
      regex: str("regex"),
      targetLabel: str("target_label"),
      replacement: str("replacement"),
    },
    end: i,
  }
}

export function parseAlloyRelabel(text: string): ImportResult {
  const tokens = tokenize(text)
  const raws: RawRelabelRule[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === "ident" && token.value === "rule" && tokens[i + 1]?.value === "{") {
      const { raw, end } = readRuleBlock(tokens, i + 2)
      raws.push(raw)
      i = end - 1
    }
  }
  return rulesFromRelabel(raws)
}
