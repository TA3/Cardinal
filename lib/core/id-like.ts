import { escapeRegex } from "@/lib/core/regex"

// Spots labels whose values look like identifiers (UUIDs, hashes, numeric IDs,
// paths with IDs in them, IPs, emails). Such labels grow without bound and are
// the usual cause of a cardinality explosion. Judged from a label's top values.

export type IdKind = "uuid" | "hex" | "numeric" | "path" | "ip" | "email"

export const ID_KIND_LABEL: Record<IdKind, string> = {
  uuid: "UUIDs",
  hex: "hex hashes",
  numeric: "numeric IDs",
  path: "paths with IDs",
  ip: "IP addresses",
  email: "email addresses",
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
// Long enough not to catch short codes like "deadbeef"-style build tags or colours.
const HEX = /^(?:0x)?[0-9a-f]{12,}$/i
const NUMERIC = /^\d{4,}$/
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?$/
const IPV6 = /^\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\]?(?::\d{1,5})?$/i
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i

/** A path or URL segment that is an ID: digits, UUID, long hex, or a long mixed token. */
function isIdSegment(segment: string) {
  if (!segment) return false
  if (/^\d{2,}$/.test(segment) || UUID.test(segment) || HEX.test(segment)) return true
  // Long random-looking tokens (base62 IDs, hashes): letters and digits mixed.
  return segment.length >= 16 && /\d/.test(segment) && /[a-z]/i.test(segment) && /^[\w-]+$/.test(segment)
}

/** The kind of ID a single value looks like, or null for a value that reads as a name. */
export function classifyValue(value: string): IdKind | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (UUID.test(trimmed)) return "uuid"
  if (EMAIL.test(trimmed)) return "email"
  if (IPV4.test(trimmed) || (trimmed.includes(":") && IPV6.test(trimmed) && /[0-9a-f]/i.test(trimmed))) return "ip"
  if (NUMERIC.test(trimmed)) return "numeric"
  if (HEX.test(trimmed) && /\d/.test(trimmed)) return "hex"
  if (trimmed.includes("/")) {
    const path = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/)[0]
    if (path.split("/").some(isIdSegment)) return "path"
  }
  return null
}

export interface IdLikeVerdict {
  kind: IdKind
  /** Share of the sampled values that look like IDs (0..1). */
  share: number
  /** Up to three sample values that look like IDs. */
  examples: string[]
}

/**
 * Flags a label when most of its top values look like one kind of ID. Needs a
 * few values to judge: with fewer than `minValues` it says nothing, since a
 * label with two values is bounded whatever they look like.
 */
export function detectIdLike(values: string[], { minValues = 3, threshold = 0.6 } = {}): IdLikeVerdict | null {
  const sample = values.filter((value) => value.trim() !== "")
  if (sample.length < minValues) return null
  const counts = new Map<IdKind, string[]>()
  for (const value of sample) {
    const kind = classifyValue(value)
    if (kind) counts.set(kind, [...(counts.get(kind) ?? []), value])
  }
  const flagged = Array.from(counts.values()).reduce((sum, list) => sum + list.length, 0)
  if (flagged / sample.length < threshold) return null
  const [kind, examples] = Array.from(counts.entries()).sort((a, b) => b[1].length - a[1].length)[0]
  return { kind, share: flagged / sample.length, examples: examples.slice(0, 3) }
}

/**
 * A pattern matching a path with its ID segments generalised, e.g.
 * `/api/users/12345/orders` → `/api/users/[^/]+/orders`. Null when the value
 * has no ID segment.
 */
export function generalizePath(value: string): string | null {
  const [path, rest] = [value.split(/[?#]/)[0], /[?#]/.test(value) ? ".*" : ""]
  const segments = path.split("/")
  if (!segments.some(isIdSegment)) return null
  return segments.map((segment) => (isIdSegment(segment) ? "[^/]+" : escapeRegex(segment))).join("/") + rest
}
