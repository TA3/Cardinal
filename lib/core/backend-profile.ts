import { adaptiveMetricsBaseUrl } from "@/lib/core/grafana-cloud"
import type { MergeChoice } from "@/lib/core/rules"

// Which metrics backend a connection talks to, and where the user's rules
// should go. Detection is pure: the source layer runs the probes
// (lib/sources/backend.ts) and hands the answers to classifyBackend.

export type BackendKind = "prometheus" | "mimir" | "grafana-cloud" | "thanos" | "victoriametrics" | "unknown"

/** /api/v1/status/buildinfo's data, as far as detection cares. */
export interface BuildInfo {
  version?: string
  application?: string
  revision?: string
  goVersion?: string
}

export interface BackendProbe {
  baseUrl: string
  /** null when buildinfo failed or doesn't exist. */
  buildinfo: BuildInfo | null
  /** /api/v1/status/tsdb answered, and with whose payload shape; null when it failed. */
  tsdb: "prometheus" | "victoriametrics" | null
  /** Mimir's cardinality API (/api/v1/cardinality/label_names) answered. */
  mimirCardinality: boolean
}

export interface BackendProfile {
  kind: BackendKind
  version: string | null
  /** The Adaptive Metrics API is reachable from this connection (a hosted Grafana Cloud Prometheus URL). */
  adaptiveApi: boolean
  /** The base URL it was detected for; a profile for another URL is stale. */
  baseUrl: string
  detectedAt: string
}

export const BACKEND_NAMES: Record<BackendKind, string> = {
  prometheus: "Prometheus",
  mimir: "Mimir",
  "grafana-cloud": "Grafana Cloud",
  thanos: "Thanos",
  victoriametrics: "VictoriaMetrics",
  unknown: "Prometheus-compatible",
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** Grafana Cloud runs weekly Mimir builds, versioned like "r411-926f316c". */
const WEEKLY_MIMIR = /^r\d+(-|$)/

export function classifyBackend(probe: BackendProbe, now = new Date()): BackendProfile {
  const build = probe.buildinfo
  const version = build?.version?.trim() || null
  const adaptiveApi = adaptiveMetricsBaseUrl(probe.baseUrl) !== null
  const profile = (kind: BackendKind): BackendProfile => ({ kind, version, adaptiveApi, baseUrl: probe.baseUrl, detectedAt: now.toISOString() })

  const cloudHost = hostOf(probe.baseUrl).endsWith(".grafana.net")
  if (adaptiveApi) return profile("grafana-cloud")
  const mimir = /mimir|cortex/i.test(build?.application ?? "") || probe.mimirCardinality
  if (mimir) return profile((version && WEEKLY_MIMIR.test(version)) || cloudHost ? "grafana-cloud" : "mimir")
  // VictoriaMetrics answers buildinfo with a fixed Prometheus-like version and nothing else.
  if (probe.tsdb === "victoriametrics" || (build && version && !build.revision && !build.goVersion)) return profile("victoriametrics")
  if (version && /^v?0\./.test(version)) return profile("thanos")
  if (version && /^v?[23]\./.test(version) && probe.tsdb === "prometheus") return profile("prometheus")
  return profile("unknown")
}

/** A profile applies while the connection's base URL is the one it was detected for. */
export function profileFor(profile: BackendProfile | null | undefined, baseUrl: string) {
  if (!profile) return null
  return profile.baseUrl.replace(/\/+$/, "") === baseUrl.trim().replace(/\/+$/, "") ? profile : null
}

// ---------------------------------------------------------------------------
// Where rules go
// ---------------------------------------------------------------------------

/**
 * Where metric rules run. "prometheus": scrape-time metric_relabel_configs.
 * "remote-write": write_relabel_configs (plus recording rules for
 * aggregations). "alloy": a prometheus.relabel block. "grafana-cloud":
 * Adaptive Metrics aggregation rules (relabel exports stay available).
 */
export type MetricsDestination = "prometheus" | "remote-write" | "alloy" | "grafana-cloud"
export type LogsDestination = "alloy" | "promtail" | "grafana-cloud"

export interface RuleDestinations {
  metrics?: MetricsDestination
  logs?: LogsDestination
}

export const METRICS_DESTINATIONS: Record<MetricsDestination, { label: string; hint: string }> = {
  prometheus: { label: "Prometheus", hint: "metric_relabel_configs at scrape" },
  "remote-write": { label: "Remote write", hint: "write_relabel_configs; local data stays whole" },
  alloy: { label: "Alloy", hint: "a prometheus.relabel block" },
  "grafana-cloud": { label: "Grafana Cloud", hint: "Adaptive Metrics rules, applied from Cardinal" },
}

export function isMetricsDestination(value: unknown): value is MetricsDestination {
  return typeof value === "string" && value in METRICS_DESTINATIONS
}

/** Adaptive Metrics only exists on Grafana Cloud. */
export function hasAdaptive(profile: Pick<BackendProfile, "kind"> | null | undefined) {
  return profile?.kind === "grafana-cloud"
}

/** The destinations worth offering: Grafana Cloud first on Grafana Cloud, never elsewhere. */
export function metricsDestinations(profile: Pick<BackendProfile, "kind"> | null | undefined): MetricsDestination[] {
  const relabel: MetricsDestination[] = ["prometheus", "remote-write", "alloy"]
  return hasAdaptive(profile) ? ["grafana-cloud", ...relabel] : relabel
}

/** The likeliest place rules run for a backend. */
export function defaultMetricsDestination(profile: Pick<BackendProfile, "kind"> | null | undefined): MetricsDestination {
  switch (profile?.kind) {
    case "grafana-cloud":
      return "grafana-cloud"
    case "mimir":
      return "alloy"
    case "victoriametrics":
      return "remote-write"
    default:
      return "prometheus"
  }
}

/** The chosen destination when it still applies to the backend, else the default. */
export function effectiveMetricsDestination(
  chosen: MetricsDestination | undefined,
  profile: Pick<BackendProfile, "kind"> | null | undefined
): MetricsDestination {
  return chosen && metricsDestinations(profile).includes(chosen) ? chosen : defaultMetricsDestination(profile)
}

/** The choices for a label drop that merges series, for a destination. Aggregating needs Adaptive Metrics or a recording rule. */
export function mergeChoicesFor(destination: MetricsDestination): MergeChoice[] {
  return destination === "grafana-cloud" || destination === "remote-write" ? ["drop", "keep_value", "aggregate"] : ["drop", "keep_value"]
}

// ---------------------------------------------------------------------------
// Where log rules go
// ---------------------------------------------------------------------------

/** What a logs destination exports: collector stages, Loki retention limits or Adaptive Logs drop rules. */
export type LogsExportFormat = "alloy" | "promtail" | "limits" | "adaptive"

export const LOGS_DESTINATIONS: Record<LogsDestination, { label: string; hint: string }> = {
  alloy: { label: "Alloy", hint: "loki.process stages in the collector" },
  promtail: { label: "Promtail", hint: "pipeline_stages in the collector" },
  "grafana-cloud": { label: "Grafana Cloud", hint: "Adaptive Logs drop rules, applied from Cardinal" },
}

export function isLogsDestination(value: unknown): value is LogsDestination {
  return typeof value === "string" && value in LOGS_DESTINATIONS
}

/** The logs destinations worth offering: Grafana Cloud (Adaptive Logs) first when the stack has it, never elsewhere. */
export function logsDestinations(adaptiveLogs: boolean): LogsDestination[] {
  return adaptiveLogs ? ["grafana-cloud", "alloy", "promtail"] : ["alloy", "promtail"]
}

export function defaultLogsDestination(adaptiveLogs: boolean): LogsDestination {
  return adaptiveLogs ? "grafana-cloud" : "alloy"
}

/** The chosen logs destination when it still applies, else the default. */
export function effectiveLogsDestination(chosen: LogsDestination | undefined, adaptiveLogs: boolean): LogsDestination {
  return chosen && logsDestinations(adaptiveLogs).includes(chosen) ? chosen : defaultLogsDestination(adaptiveLogs)
}

/**
 * The export formats for a logs destination, primary first. Collectors also
 * get Loki retention limits (self-managed Loki); Grafana Cloud gets Alloy for
 * what Adaptive Logs can't do (label moves and drops).
 */
export function logsFormatsFor(destination: LogsDestination): LogsExportFormat[] {
  switch (destination) {
    case "grafana-cloud":
      return ["adaptive", "alloy"]
    case "promtail":
      return ["promtail", "limits"]
    default:
      return ["alloy", "limits"]
  }
}
