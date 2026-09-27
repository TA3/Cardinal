// RE2 helpers for relabel regexes. Relabel regexes are fully anchored, so a
// plain alternation of escaped literals matches exactly those names.

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function literalAlternation(values: string[]) {
  return Array.from(new Set(values))
    .sort((a, b) => a.localeCompare(b))
    .map(escapeRegex)
    .join("|")
}

/** Escapes one part of a regex over joined source labels, including the separators. */
export function escapeJoinedPart(value: string, separator = ";") {
  const escaped = escapeRegex(value).replace(/;/g, "\\;")
  if (separator === ";" || !separator) return escaped
  return escaped.split(separator).join(`\\${separator}`)
}

const SEPARATORS = [";", ",", "#", "@", "~", "!", "%", "&", "=", "/"]

/**
 * Separator for relabel rules joining `job` with other labels. Defaults to ";"
 * but avoids any character in the job, so the joined value stays unambiguous.
 */
export function joinSeparator(job: string | undefined) {
  if (!job) return ";"
  return SEPARATORS.find((separator) => !job.includes(separator)) ?? "\u001f"
}

function unescapeRegex(value: string) {
  return value.replace(/\\([^A-Za-z0-9])/g, "$1")
}

function stripWrappingGroup(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return trimmed

  let depth = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === "\\") {
      i += 1
    } else if (char === "(") {
      depth += 1
    } else if (char === ")") {
      depth -= 1
      if (depth === 0 && i < trimmed.length - 1) return trimmed
    }
  }
  return trimmed.slice(1, -1).replace(/^\?:/, "").trim()
}

function splitTopLevel(value: string, separator: string) {
  const parts: string[] = []
  let start = 0
  let depth = 0
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (char === "\\") {
      i += 1
    } else if (char === "(" || char === "[") {
      depth += 1
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1)
    } else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/**
 * Splits a relabel regex over joined source labels into the regex for each
 * source label, or null when it has a top-level alternation (`a;b|c;d`),
 * which cannot be split per label.
 */
export function splitJoinedRegex(regex: string, separator = ";") {
  if (splitTopLevel(regex, "|").length > 1) return null
  return splitTopLevel(regex, separator)
}

// Only escapes of punctuation are literal; `\d`, `\w`, `\b`... are classes.
const LITERAL = /^(?:[^.*+?^${}()|[\]\\]|\\[^A-Za-z0-9])+$/

/**
 * Returns the literal names matched by a regex like `a|b\.c|(d|e)`, or null
 * when the regex contains anything other than escaped literals.
 */
export function parseLiteralAlternation(regex: string): string[] | null {
  const body = stripWrappingGroup(regex.replace(/^\^/, "").replace(/\$$/, ""))
  const parts = splitTopLevel(body, "|").map((part) => stripWrappingGroup(part))
  const names: string[] = []
  for (const part of parts) {
    if (part.includes("|")) {
      const nested = parseLiteralAlternation(part)
      if (!nested) return null
      names.push(...nested)
    } else if (LITERAL.test(part)) {
      names.push(unescapeRegex(part))
    } else {
      return null
    }
  }
  return names
}

// RE2 (Prometheus, Alloy) lacks lookaround and backreferences; JS has them, so
// they are rejected explicitly before the JS parser gets a say.
const NON_RE2 = /\(\?<?[=!]|\\[1-9]|\\k</
const MAX_REGEX_LENGTH = 500

/** True when every "(" closes within the regex, ignoring escapes and character classes. */
function balancedGroups(regex: string) {
  let depth = 0
  let inClass = false
  for (let i = 0; i < regex.length; i += 1) {
    const char = regex[i]
    if (char === "\\") i += 1
    else if (inClass) inClass = char !== "]"
    else if (char === "[") {
      inClass = true
      // "]" right after "[" or "[^" is a literal.
      if (regex[i + 1] === "^") i += 1
      if (regex[i + 1] === "]") i += 1
    } else if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && !inClass
}

/** Why a user regex can't be used in a relabel rule or PromQL matcher; null when it can. */
export function regexProblem(regex: string): string | null {
  if (!regex) return "empty"
  if (regex.length > MAX_REGEX_LENGTH) return `longer than ${MAX_REGEX_LENGTH} characters`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(regex)) return "contains control characters"
  if (NON_RE2.test(regex)) return "lookarounds and backreferences are not supported by RE2"
  // Cardinal wraps the regex in a group; an unbalanced one could escape it (`a)|(b`).
  if (!balancedGroups(regex)) return "unbalanced parentheses"
  try {
    new RegExp(`^(?:${regex})$`)
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : "does not parse"
  }
  return null
}

export function isSafeRegex(regex: string) {
  return regexProblem(regex) === null
}

/** Tests a value the way relabelling and PromQL do: the whole value must match. */
export function fullMatch(regex: string, value: string) {
  try {
    return new RegExp(`^(?:${regex})$`).test(value)
  } catch {
    return false
  }
}
