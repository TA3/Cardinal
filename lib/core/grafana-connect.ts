import type { Signal } from "@/lib/core/signals"
import {
  adaptiveLogsBaseUrl,
  adaptiveMetricsBaseUrl,
  bareBaseUrl,
  datasourceProxyUrl,
  type DatasourceType,
  type GrafanaDatasource,
} from "@/lib/core/grafana-cloud"

// Structural copies of lib/sources/transport's types (lib/core stays DOM-free).
type AuthMode = "none" | "basic" | "bearer" | "grafana-cloud" | "mimir"
type TransportMode = "direct" | "proxy" | "relay"

// "Connect Grafana" as pure planning: which Prometheus and Loki data sources a
// Grafana offers (detectGrafanaDatasources), and the per-signal connection
// settings a set of choices turns into (connectGrafana). The dialog does the
// fetching and applying; everything here is testable without a network.

export const SIGNAL_DATASOURCE: Record<Signal, DatasourceType> = { metrics: "prometheus", logs: "loki" }

/** A Grafana Cloud stack, from a `<slug>.grafana.net` Grafana URL. */
export interface GrafanaStack {
  slug: string
  url: string
}

export interface DatasourceCandidate extends GrafanaDatasource {
  /** The base URL that reaches it through Grafana's data source proxy. */
  proxyUrl: string
  /** The Grafana Cloud Adaptive API host behind it, when its `url` is a hosted Prometheus or Loki. */
  adaptiveBaseUrl: string | null
  /** Why it is unlikely to be the one to analyse (e.g. a machine-learning endpoint). */
  note?: string
}

export interface SignalDetection {
  signal: Signal
  type: DatasourceType
  candidates: DatasourceCandidate[]
  /** The one to preselect: the remembered choice, else Grafana's default, else the likeliest. Null when there are none. */
  preselected: string | null
  /** True when the remembered choice was "don't use Grafana for this signal". */
  rememberedSkip: boolean
  /** More than one candidate: the user picks explicitly and the choice is remembered. */
  choiceNeeded: boolean
}

export interface GrafanaDetection {
  grafanaUrl: string
  anonymous: boolean
  stack: GrafanaStack | null
  metrics: SignalDetection
  logs: SignalDetection
  /** Grafana Cloud facts worth telling the user, per signal. */
  adaptive: Record<Signal, AdaptiveOffer>
}

/**
 * What Adaptive Metrics / Logs needs for a signal. "available": the data
 * source's own URL is a Grafana Cloud host, so Cardinal can connect to it
 * directly with the stack's instance ID and an access policy token.
 * "hidden": a Cloud stack whose data source URLs aren't visible to this
 * token. "none": not Grafana Cloud.
 */
export type AdaptiveOffer =
  | { kind: "available"; baseUrl: string; datasourceUrl: string }
  | { kind: "hidden" }
  | { kind: "none" }

/** Remembered per-signal choices: a data source uid, or null for "don't use Grafana". */
export type RememberedChoices = Partial<Record<Signal, string | null>>

function stackOf(grafanaUrl: string): GrafanaStack | null {
  try {
    const url = new URL(grafanaUrl)
    const match = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.grafana\.net$/)
    return match ? { slug: match[1], url: `${url.protocol}//${url.host}` } : null
  } catch {
    return null
  }
}

/** Grafana Cloud ships machine-learning endpoints as Prometheus data sources; they aren't the metrics store. */
function noteFor(datasource: GrafanaDatasource) {
  if (datasource.url && /\/machine-learning\//.test(datasource.url)) return "Machine-learning endpoint, not a metrics store"
  return undefined
}

function adaptiveFor(type: DatasourceType, url: string | undefined) {
  if (!url) return null
  return type === "prometheus" ? adaptiveMetricsBaseUrl(url) : adaptiveLogsBaseUrl(url)
}

/** Likeliest first: Grafana's default, then real stores (not ML), then Grafana Cloud's own hosted ones, then by name. */
function rank(candidate: DatasourceCandidate) {
  return (candidate.isDefault ? 0 : 4) + (candidate.note ? 2 : 0) + (candidate.adaptiveBaseUrl ? 0 : 1)
}

function detectSignal(signal: Signal, grafanaUrl: string, datasources: GrafanaDatasource[], remembered: RememberedChoices): SignalDetection {
  const type = SIGNAL_DATASOURCE[signal]
  const candidates: DatasourceCandidate[] = datasources
    .filter((datasource) => datasource.type === type)
    .map((datasource) => ({
      ...datasource,
      proxyUrl: datasourceProxyUrl(grafanaUrl, datasource.uid),
      adaptiveBaseUrl: adaptiveFor(type, datasource.url),
      note: noteFor(datasource),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const choice = remembered[signal]
  const rememberedSkip = choice === null && candidates.length > 0
  const rememberedUid = typeof choice === "string" && candidates.some((candidate) => candidate.uid === choice) ? choice : null
  return {
    signal,
    type,
    candidates,
    preselected: rememberedSkip ? null : (rememberedUid ?? candidates[0]?.uid ?? null),
    rememberedSkip,
    choiceNeeded: candidates.length > 1,
  }
}

function adaptiveOffer(detection: SignalDetection, stack: GrafanaStack | null, preferredUid: string | null): AdaptiveOffer {
  const candidate =
    detection.candidates.find((item) => item.uid === preferredUid && item.adaptiveBaseUrl) ??
    detection.candidates.find((item) => item.adaptiveBaseUrl && !item.note)
  if (candidate?.adaptiveBaseUrl && candidate.url) return { kind: "available", baseUrl: candidate.adaptiveBaseUrl, datasourceUrl: candidate.url }
  if (stack && detection.candidates.some((item) => !item.url)) return { kind: "hidden" }
  return { kind: "none" }
}

/** Sorts a Grafana's data sources into per-signal choices and spots Grafana Cloud. */
export function detectGrafanaDatasources(input: {
  grafanaUrl: string
  token?: string
  datasources: GrafanaDatasource[]
  remembered?: RememberedChoices
}): GrafanaDetection {
  const grafanaUrl = bareBaseUrl(input.grafanaUrl)
  const remembered = input.remembered ?? {}
  const stack = stackOf(grafanaUrl)
  const metrics = detectSignal("metrics", grafanaUrl, input.datasources, remembered)
  const logs = detectSignal("logs", grafanaUrl, input.datasources, remembered)
  return {
    grafanaUrl,
    anonymous: !input.token?.trim(),
    stack,
    metrics,
    logs,
    adaptive: { metrics: adaptiveOffer(metrics, stack, metrics.preselected), logs: adaptiveOffer(logs, stack, logs.preselected) },
  }
}

/**
 * What to do for one signal. "grafana": through the data source proxy with the
 * Grafana token. "cloud": straight to the Grafana Cloud host behind the data
 * source (needed for Adaptive Metrics / Logs) with an instance ID and access
 * policy token. "skip": leave the signal's connection as it is.
 */
export type SignalChoice =
  | { use: "skip" }
  | { use: "grafana"; uid: string }
  | { use: "cloud"; uid: string; instanceId: string; token: string }

/** Connection fields for a signal; the store merges them over the signal's other settings. */
export interface PlannedConnection {
  baseUrl: string
  authMode: AuthMode
  instanceId: string
  token: string
  tenant: string
  mode: TransportMode
  rememberToken: boolean
}

/** Which data source a signal is connected through, kept so the connection form can say "via Grafana". */
export interface GrafanaDatasourceLink {
  grafanaUrl: string
  uid: string
  name: string
  /** The exact base URL applied; the link holds while the signal's URL is still this. */
  baseUrl: string
  via: "grafana" | "cloud"
}

export interface SignalPlan {
  signal: Signal
  connection: PlannedConnection
  link: GrafanaDatasourceLink
}

export interface ConnectPlan {
  grafanaUrl: string
  signals: SignalPlan[]
  /** Signals left as they are. */
  skipped: Signal[]
  /** Choices to remember for the next run (null = don't use Grafana for it). */
  remember: RememberedChoices
  scan: boolean
  /** Why the plan can't be applied yet; empty when it can. */
  problems: string[]
}

/** Turns the user's choices into per-signal connection settings. */
export function connectGrafana(
  detection: GrafanaDetection,
  options: {
    token: string
    mode: TransportMode
    rememberToken: boolean
    choices: Partial<Record<Signal, SignalChoice>>
    scan: boolean
  }
): ConnectPlan {
  const token = options.token.trim()
  const signals: SignalPlan[] = []
  const skipped: Signal[] = []
  const remember: RememberedChoices = {}
  const problems: string[] = []

  for (const signal of ["metrics", "logs"] as const) {
    const detected = detection[signal]
    const choice = options.choices[signal] ?? { use: "skip" }
    if (choice.use === "skip") {
      skipped.push(signal)
      if (detected.candidates.length) remember[signal] = null
      continue
    }
    const candidate = detected.candidates.find((item) => item.uid === choice.uid)
    const noun = signal === "logs" ? "Loki" : "Prometheus"
    if (!candidate) {
      problems.push(`Pick a ${noun} data source, or don't use Grafana for ${signal}.`)
      continue
    }
    remember[signal] = candidate.uid
    if (choice.use === "cloud") {
      if (!candidate.url || !candidate.adaptiveBaseUrl) {
        problems.push(`${candidate.name} isn't a Grafana Cloud ${noun}, so it can't be reached directly.`)
        continue
      }
      if (!choice.instanceId.trim() || !choice.token.trim()) {
        problems.push(`Enter the ${signal === "logs" ? "Loki user" : "instance"} ID and an access policy token for ${candidate.name}.`)
        continue
      }
      const baseUrl = bareBaseUrl(candidate.url)
      signals.push({
        signal,
        connection: {
          baseUrl,
          authMode: "grafana-cloud",
          instanceId: choice.instanceId.trim(),
          token: choice.token.trim(),
          tenant: "",
          mode: "proxy",
          rememberToken: options.rememberToken,
        },
        link: { grafanaUrl: detection.grafanaUrl, uid: candidate.uid, name: candidate.name, baseUrl, via: "cloud" },
      })
      continue
    }
    signals.push({
      signal,
      connection: {
        baseUrl: candidate.proxyUrl,
        authMode: token ? "bearer" : "none",
        instanceId: "",
        token,
        tenant: "",
        mode: options.mode,
        rememberToken: options.rememberToken,
      },
      link: { grafanaUrl: detection.grafanaUrl, uid: candidate.uid, name: candidate.name, baseUrl: candidate.proxyUrl, via: "grafana" },
    })
  }

  if (!signals.length && !options.scan && !problems.length) problems.push("Pick at least one data source, or scan dashboards.")
  return { grafanaUrl: detection.grafanaUrl, signals, skipped, remember, scan: options.scan, problems }
}

/** The link that still describes a signal's connection, or null once its URL was changed by hand. */
export function activeLink(link: GrafanaDatasourceLink | undefined, baseUrl: string): GrafanaDatasourceLink | null {
  const bare = (url: string) => url.trim().replace(/\/+$/, "")
  return link && bare(baseUrl) && bare(baseUrl) === bare(link.baseUrl) ? link : null
}
