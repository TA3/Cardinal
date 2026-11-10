import { normalizeAttribution, type AttributionSettings } from "@/lib/core/attribution"
import { fromLogRuleSet, toLogRuleSet } from "@/lib/core/logs/share"
import type { LogRule } from "@/lib/core/logs/types"
import type { Rule } from "@/lib/core/rules"
import { base64UrlDecode, base64UrlEncode, fromRuleSet, toRuleSet } from "@/lib/core/share"

// "Continue on your machine": the hosted app hands its work to a local
// `cardinal` server in the link's #fragment, which no server ever sees.
// Browser storage isn't shared between the two origins, so without this the
// switch would start from nothing. Tokens are never carried. The receiving
// side treats it like any shared link: every field is validated and the user
// confirms before anything is applied.

export const HANDOFF_KEY = "handoff"
const HANDOFF_VERSION = 1
/** Where the local server listens by default (server/config.ts DEFAULT_PORT). */
export const LOCAL_APP_URL = "http://localhost:9181"

const MAX_TEXT = 200
const MAX_URL = 2000

export interface HandoffConnection {
  baseUrl: string
  /** Username or Grafana Cloud instance ID: an identifier, not a secret. */
  instanceId?: string
  tenant?: string
}

export interface HandoffInput {
  metrics?: HandoffConnection
  logs?: HandoffConnection
  grafana?: { baseUrl: string }
  rules: Rule[]
  logRules: LogRule[]
  prices: { perSeries?: number; perGB?: number }
  autopilot: boolean
  attribution: AttributionSettings
  /** The connection form to open on arrival. */
  open?: "metrics" | "logs"
}

/** What a handoff link carries, after validation. Rules keep whether they were active or proposed. */
export interface Handoff {
  metrics?: HandoffConnection
  logs?: HandoffConnection
  grafana?: { baseUrl: string }
  rules: Rule[]
  logRules: LogRule[]
  prices: { perSeries?: number; perGB?: number }
  autopilot: boolean
  attribution?: AttributionSettings
  open?: "metrics" | "logs"
  warnings: string[]
}

function connectionOut(connection: HandoffConnection | undefined) {
  if (!connection?.baseUrl.trim()) return undefined
  const { baseUrl, instanceId, tenant } = connection
  return { baseUrl: baseUrl.trim(), ...(instanceId?.trim() ? { instanceId: instanceId.trim() } : {}), ...(tenant?.trim() ? { tenant: tenant.trim() } : {}) }
}

/** The fragment for the local app's URL: `#handoff=<base64url JSON>`. */
export function handoffHash(input: HandoffInput) {
  const byStatus = <T extends { status: string }>(rules: T[], status: string) => rules.filter((rule) => rule.status === status)
  const payload = {
    v: HANDOFF_VERSION,
    metrics: connectionOut(input.metrics),
    logs: connectionOut(input.logs),
    grafana: input.grafana?.baseUrl.trim() ? { baseUrl: input.grafana.baseUrl.trim() } : undefined,
    rules: { active: toRuleSet(byStatus(input.rules, "active")), proposed: toRuleSet(byStatus(input.rules, "proposed")) },
    logRules: { active: toLogRuleSet(byStatus(input.logRules, "active")), proposed: toLogRuleSet(byStatus(input.logRules, "proposed")) },
    prices: input.prices,
    autopilot: input.autopilot,
    attribution: input.attribution,
    open: input.open,
  }
  return `#${HANDOFF_KEY}=${base64UrlEncode(JSON.stringify(payload))}`
}

/** The local app's URL carrying the handoff. It opens on Savings: "/" redirects, which would drop the fragment. */
export function handoffUrl(input: HandoffInput, base = LOCAL_APP_URL) {
  return `${base}/savings${handoffHash(input)}`
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

function text(value: unknown) {
  if (typeof value !== "string") return undefined
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim()
  return flat && flat.length <= MAX_TEXT ? flat : undefined
}

function url(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_URL) return undefined
  try {
    const parsed = new URL(value.trim())
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined
    return value.trim().replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

function connectionIn(value: unknown, name: string, warnings: string[]): HandoffConnection | undefined {
  if (value === undefined) return undefined
  const baseUrl = isObject(value) ? url(value.baseUrl) : undefined
  if (!isObject(value) || !baseUrl) {
    warnings.push(`The ${name} URL wasn't valid and was left out.`)
    return undefined
  }
  const instanceId = text(value.instanceId)
  const tenant = text(value.tenant)
  return { baseUrl, ...(instanceId ? { instanceId } : {}), ...(tenant ? { tenant } : {}) }
}

function price(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1e6 ? value : undefined
}

/** Reads a handoff from a location hash; null when the hash carries none. Throws on a malformed link. */
export function readHandoffHash(hash: string): Handoff | null {
  const encoded = new URLSearchParams(hash.replace(/^#/, "")).get(HANDOFF_KEY)
  if (!encoded) return null
  const raw: unknown = JSON.parse(base64UrlDecode(encoded))
  if (!isObject(raw) || raw.v !== HANDOFF_VERSION) throw new Error("This handoff link is from another version of Cardinal.")
  const warnings: string[] = []

  const ruleSets = isObject(raw.rules) ? raw.rules : {}
  const rules: Rule[] = []
  for (const status of ["active", "proposed"] as const) {
    if (ruleSets[status] === undefined) continue
    const parsed = fromRuleSet(ruleSets[status])
    warnings.push(...parsed.warnings)
    rules.push(...parsed.rules.map((rule) => ({ ...rule, status })))
  }
  const logRuleSets = isObject(raw.logRules) ? raw.logRules : {}
  const logRules: LogRule[] = []
  for (const status of ["active", "proposed"] as const) {
    if (logRuleSets[status] === undefined) continue
    const parsed = fromLogRuleSet(logRuleSets[status])
    warnings.push(...parsed.warnings)
    logRules.push(...parsed.rules.map((rule) => ({ ...rule, status })))
  }

  const grafanaUrl = isObject(raw.grafana) ? url(raw.grafana.baseUrl) : undefined
  const prices = isObject(raw.prices) ? raw.prices : {}
  const perSeries = price(prices.perSeries)
  const perGB = price(prices.perGB)
  const attribution = isObject(raw.attribution) ? normalizeAttribution(raw.attribution) : undefined
  const metrics = connectionIn(raw.metrics, "metrics", warnings)
  const logs = connectionIn(raw.logs, "logs", warnings)
  return {
    ...(metrics ? { metrics } : {}),
    ...(logs ? { logs } : {}),
    ...(grafanaUrl ? { grafana: { baseUrl: grafanaUrl } } : {}),
    rules,
    logRules,
    prices: { ...(perSeries !== undefined ? { perSeries } : {}), ...(perGB !== undefined ? { perGB } : {}) },
    autopilot: raw.autopilot === true,
    ...(attribution && (attribution.enabled || attribution.owners.length || attribution.labels.some(Boolean)) ? { attribution } : {}),
    ...(raw.open === "metrics" || raw.open === "logs" ? { open: raw.open } : {}),
    warnings,
  }
}
