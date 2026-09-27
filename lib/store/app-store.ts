import { toast } from "sonner"
import { create } from "zustand"
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware"

import type { CreatedSession } from "@/lib/agent/protocol"
import type { RelabelMode } from "@/lib/core/compile/plan"
import {
  activateOrCreate,
  createRule,
  mergeRules,
  ruleKey,
  sortUnique,
  type Rule,
  type RuleImpact,
  type RuleSelector,
  type RuleStatus,
} from "@/lib/core/rules"
import type { SnapshotProgress } from "@/lib/sources/prometheus"
import { inferAuthMode, type AuthMode, type Connection, type TransportMode } from "@/lib/sources/transport"
import type { Snapshot } from "@/lib/core/snapshot"
import { DEFAULT_ATTRIBUTION, migrateTeamsToAttribution, type AttributionSettings } from "@/lib/core/attribution"
import { createOwner, type Owner } from "@/lib/core/owner-rules"
import { isSignal, signalFromPath, type Signal } from "@/lib/core/signals"
import { DEFAULT_LOGS_RANGE, isLogsRange, summarizeLogsSnapshot } from "@/lib/core/logs/snapshot"
import type { LogsRange, LogsSnapshot, LogsSnapshotProgress, LogsSnapshotSummary } from "@/lib/core/logs/types"
import { activateOrCreateLogRule, foldLogRules, mergeLogRules, migrateKeepHacks, toggleLogRule, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LogRule, LogRuleImpact, LogRuleStatus } from "@/lib/core/logs/types"
import type { MetricDrilldown } from "@/lib/prometheus/types"
import type { GrafanaDatasourceLink, RememberedChoices } from "@/lib/core/grafana-connect"

// App state shared by the UI and the agent bridge. Server data that is cheap to
// refetch lives here too so the agent can answer from what the user has loaded.

export interface ConnectionSettings {
  baseUrl: string
  authMode: AuthMode
  /** Basic auth username or Grafana Cloud instance ID. */
  instanceId: string
  /** Password, bearer token or access policy token. */
  token: string
  /** Mimir tenant (X-Scope-OrgID); used by the "mimir" auth mode. */
  tenant: string
  mode: TransportMode
  /** When false the token is kept in memory only. */
  rememberToken: boolean
  topN: number
  /** Price per 1,000 active series per month, for cost estimates. Unset until the user enters one. */
  pricePer1kSeries?: number
  /** Price per GB of logs ingested (1024³ bytes), for logs cost estimates. Unset until the user enters one. */
  pricePerGB?: number
}

/** The logs (Loki) connection: the same fields as metrics, plus the snapshot's range and grouping. */
export interface LogsConnectionSettings extends ConnectionSettings {
  /** Range the logs snapshot covers. */
  range: LogsRange
  /** Label to group streams by; auto-picked (service_name, job, app) when unset. */
  groupLabel?: string
}

/**
 * The one Grafana connection: data source picking (Connect Grafana), the
 * dashboard and alert usage scan, and dashboard export all use it.
 */
export interface GrafanaSettings {
  baseUrl: string
  /** Service account token (Viewer is enough to read); empty for anonymous access. Kept in memory unless rememberToken. */
  token: string
  mode: TransportMode
  rememberToken: boolean
  /** Data source picked per signal on the last Connect Grafana run (null = don't use Grafana for it). Reset when the URL changes. */
  choices: RememberedChoices
}

export const DEFAULT_GRAFANA_SETTINGS: GrafanaSettings = { baseUrl: "", token: "", mode: "proxy", rememberToken: false, choices: {} }

export interface AgentActivity {
  at: string
  tool: string
  ok: boolean
  detail?: string
  /** Arguments the agent passed. */
  args?: unknown
  /** How long the call took in this tab. */
  durationMs?: number
}

export type AgentLinkStatus = "idle" | "connecting" | "connected" | "disconnected" | "expired" | "elsewhere"

export interface AddRulesResult {
  /** Rules added, or existing rules that gained labels. */
  added: number
  /** Rules that changed nothing: duplicates, or proposals an active rule already covers. */
  skipped: number
}

/** Per-metric series counts of a replaced snapshot, for "since last snapshot" deltas. */
export interface SnapshotSummary {
  capturedAt?: string
  totalSeries: number
  metricCount: number
  /** The largest metrics only (see SUMMARY_METRICS), to keep storage small. */
  metrics: Record<string, number>
  /** True when `metrics` was cut to the largest ones. */
  truncated: boolean
}

export const SUMMARY_METRICS = 500

export function summarizeSnapshot(snapshot: Snapshot): SnapshotSummary {
  const top = [...snapshot.metrics].sort((a, b) => b.seriesCount - a.seriesCount).slice(0, SUMMARY_METRICS)
  return {
    capturedAt: snapshot.capturedAt,
    totalSeries: snapshot.totalSeries,
    metricCount: snapshot.metricCount,
    metrics: Object.fromEntries(top.map((metric) => [metric.metric, metric.seriesCount])),
    truncated: snapshot.metrics.length > SUMMARY_METRICS,
  }
}

/** Which backend a snapshot came from; the token is left out so re-entering it keeps the history. */
function snapshotSourceOf(settings: ConnectionSettings) {
  return `${settings.baseUrl.trim()}|${settings.instanceId.trim()}`
}

/**
 * The summary to keep when `next` replaces the current snapshot: the current
 * one, unless it is the same snapshot or came from another backend.
 */
function previousFor(state: Pick<AppState, "snapshot" | "snapshotSource" | "previousSnapshotSummary">, next: Snapshot | null, source: string) {
  const current = state.snapshot
  if (!next) return null
  if (state.snapshotSource && state.snapshotSource !== source) return null
  if (!current || current === next || (current.capturedAt && current.capturedAt === next.capturedAt)) return state.previousSnapshotSummary
  return summarizeSnapshot(current)
}

interface AppState {
  settings: ConnectionSettings
  snapshot: Snapshot | null
  /** The snapshot before the current one (same connection), summarised. */
  previousSnapshotSummary: SnapshotSummary | null
  /** Base URL and instance the current snapshot came from. */
  snapshotSource: string | null
  drilldowns: Record<string, MetricDrilldown>
  rules: Rule[]
  relabelMode: RelabelMode
  activityLog: string[]
  /** A token was in use for this connection; with "remember token" off a reload loses it. */
  tokenExpected: boolean
  /** The last request was rejected with 401/403. Not persisted. */
  authError: boolean

  agentSession: CreatedSession | null
  agentStatus: AgentLinkStatus
  agentActivity: AgentActivity[]
  /** While true every agent tool call is refused with "paused by user"; the session stays open. Not persisted. */
  agentPaused: boolean
  /** When false, get_label_values refuses to share label values with the agent. */
  agentShareLabelValues: boolean
  /**
   * Progress of the snapshot running now, null when none is. `total` is 0
   * while unknown (a single query, or listing jobs); per-job fallbacks on
   * large tenants count jobs in `done` / `total`. Not persisted.
   */
  snapshotProgress: SnapshotProgress | null

  /** Changing the base URL, instance or token drops data tied to the old connection. */
  updateSettings: (patch: Partial<ConnectionSettings>) => void
  switchConnection: (settings: ConnectionSettings, snapshot: Snapshot) => void
  setSnapshot: (snapshot: Snapshot | null) => void
  setAuthError: (authError: boolean) => void
  cacheDrilldown: (drilldown: MetricDrilldown) => void
  log: (message: string) => void
  resetAll: () => void

  /** `job` undefined toggles the rule for all jobs; a string (including "") scopes it to that job. */
  toggleDropMetric: (metric: string, job?: string) => void
  toggleDropLabel: (metric: string, label: string, job?: string) => void
  removeMetricRules: (metric: string) => void
  removeRule: (id: string) => void
  clearRules: () => void
  addRules: (rules: Rule[]) => AddRulesResult
  replaceRules: (rules: Rule[]) => AddRulesResult
  setRuleStatus: (ids: string[], status: Rule["status"]) => void
  setRuleImpact: (id: string, impact: RuleImpact | undefined) => void
  invalidateImpacts: () => void
  setRelabelMode: (mode: RelabelMode) => void

  setAgentSession: (session: CreatedSession | null) => void
  setAgentStatus: (status: AgentLinkStatus) => void
  recordAgentActivity: (activity: AgentActivity) => void
  setAgentPaused: (paused: boolean) => void
  setAgentShareLabelValues: (share: boolean) => void
  setSnapshotProgress: (progress: SnapshotProgress | null) => void

  /** Attribution: whether it is on, its labels, and custom owner rules checked in order. */
  attribution: AttributionSettings
  setAttribution: (patch: Partial<Omit<AttributionSettings, "owners">>) => void
  setOwners: (owners: Owner[]) => void
  addOwner: (name: string, rules?: Owner["rules"]) => Owner
  updateOwner: (id: string, patch: Partial<Omit<Owner, "id">>) => void
  removeOwner: (id: string) => void
  /** Moves an owner up (-1) or down (+1) in the matching order. */
  moveOwner: (id: string, delta: number) => void

  /** The signal in view. Signal routes set it from the URL; shared pages (rules, agent…) follow it. */
  signal: Signal
  /** Each signal's last visited page (path and query), per tab (sessionStorage). */
  lastPathBySignal: Partial<Record<Signal, string>>
  /** Records a visited path: sets the signal and its last page when the path belongs to one. */
  visitPath: (path: string) => void

  /** The logs (Loki) connection, separate from the metrics one in `settings`. */
  logsSettings: LogsConnectionSettings
  logsSnapshot: LogsSnapshot | null
  /** The logs snapshot before the current one (same connection), summarised. */
  previousLogsSnapshotSummary: LogsSnapshotSummary | null
  /** Base URL and instance the current logs snapshot came from. */
  logsSnapshotSource: string | null
  logsTokenExpected: boolean
  /** The last logs request was rejected with 401. Not persisted. */
  logsAuthError: boolean
  /** Progress of the logs snapshot running now, null when none is. Not persisted. */
  logsSnapshotProgress: LogsSnapshotProgress | null
  /** Changing the base URL, instance or token drops the logs snapshot's auth error. */
  updateLogsSettings: (patch: Partial<LogsConnectionSettings>) => void
  switchLogsConnection: (settings: LogsConnectionSettings, snapshot: LogsSnapshot) => void
  setLogsSnapshot: (snapshot: LogsSnapshot | null) => void
  setLogsAuthError: (authError: boolean) => void
  setLogsSnapshotProgress: (progress: LogsSnapshotProgress | null) => void

  /** Log (Loki) rules, kept apart from the metric `rules`. Persisted. */
  logRules: LogRule[]
  /** Merges like addRules (lib/core/logs/rules mergeLogRules). */
  addLogRules: (rules: LogRule[]) => AddRulesResult
  setLogRuleStatus: (ids: string[], status: LogRuleStatus) => void
  setLogRuleImpact: (id: string, impact: LogRuleImpact | undefined) => void
  removeLogRule: (id: string) => void
  /** Removes active and rejected log rules; proposals stay for review, as with clearRules. */
  clearLogRules: () => void
  /** Turns the rule with the candidate's key off when active, else activates or creates it. Throws on an invalid candidate. */
  toggleLogRule: (candidate: LogRuleInput) => void
  /** Makes the candidate active (updating keep or days). Throws on an invalid candidate. */
  activateLogRule: (candidate: LogRuleInput) => void
  invalidateLogImpacts: () => void

  /** The Grafana connection (URL, token, proxy), shared by Connect Grafana, the usage scan and dashboard export. */
  grafanaSettings: GrafanaSettings
  /** Signals connected with Connect Grafana, and through which data source. A link lapses once the signal's URL changes (activeLink). */
  grafanaLinks: Partial<Record<Signal, GrafanaDatasourceLink>>
  updateGrafanaSettings: (patch: Partial<GrafanaSettings>) => void
  /** Sets or (with null) removes signals' Grafana links. */
  setGrafanaLinks: (links: Partial<Record<Signal, GrafanaDatasourceLink | null>>) => void
  /** Clears a signal's connection and snapshot; its rules stay. */
  disconnectSignal: (signal: Signal) => void
}

const defaultSettings: ConnectionSettings = {
  baseUrl: "",
  authMode: "none",
  instanceId: "",
  token: "",
  tenant: "",
  mode: "direct",
  rememberToken: false,
  topN: 20,
}

const defaultLogsSettings: LogsConnectionSettings = { ...defaultSettings, mode: "proxy", range: DEFAULT_LOGS_RANGE }

/**
 * The logs summary to keep when `next` replaces the current logs snapshot, as
 * for metrics: the current one, unless it is the same or from another backend.
 */
function previousLogsFor(
  state: Pick<AppState, "logsSnapshot" | "logsSnapshotSource" | "previousLogsSnapshotSummary">,
  next: LogsSnapshot | null,
  source: string
) {
  const current = state.logsSnapshot
  if (!next) return null
  if (state.logsSnapshotSource && state.logsSnapshotSource !== source) return null
  if (!current || current === next || current.capturedAt === next.capturedAt) return state.previousLogsSnapshotSummary
  return summarizeLogsSnapshot(current)
}

export const PERSIST_KEY = "cardinal.state.v2"
/** Before v8 the Grafana connection had its own store (the usage scan's). */
const LEGACY_GRAFANA_KEY = "cardinal.grafana.v1"

function bareUrl(url: string) {
  return url.trim().replace(/\/+$/, "")
}

function loadLegacyGrafana(): GrafanaSettings | null {
  try {
    const raw = localStorage.getItem(LEGACY_GRAFANA_KEY)
    const settings = raw ? (JSON.parse(raw) as { state?: { settings?: Partial<GrafanaSettings> } }).state?.settings : undefined
    return settings ? { ...DEFAULT_GRAFANA_SETTINGS, ...settings, choices: {} } : null
  } catch {
    return null
  }
}
const LEGACY_NO_JOB = "(no job)"

function isQuotaError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014)
  )
}

let warnedSnapshotSkipped = false
let warnedRulesUnsaved = false

/** Persists without the snapshot, keeping rules and settings, when storage is full. */
function setWithoutSnapshot(name: string, value: string) {
  const parsed = JSON.parse(value) as { state?: Record<string, unknown> }
  if (!parsed.state || parsed.state.snapshot == null) throw new Error("nothing to trim")
  parsed.state = { ...parsed.state, snapshot: null, logsSnapshot: null, snapshotOmitted: true }
  localStorage.setItem(name, JSON.stringify(parsed))
}

/** Storage that never throws mid-render; when full it drops the snapshot before giving up. */
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
      warnedSnapshotSkipped = false
      warnedRulesUnsaved = false
      return
    } catch (error) {
      if (!isQuotaError(error)) return
    }
    try {
      setWithoutSnapshot(name, value)
      if (!warnedSnapshotSkipped) {
        warnedSnapshotSkipped = true
        toast.warning("Browser storage is full", {
          description: "The snapshot won't survive a reload; rules and settings are still saved.",
        })
      }
    } catch {
      if (!warnedRulesUnsaved) {
        warnedRulesUnsaved = true
        toast.error("Rules could not be saved", {
          description: "Browser storage is full. Export your rules before closing this tab.",
        })
      }
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // ignore
    }
  },
}

function connectionIdentity(settings: ConnectionSettings) {
  return `${settings.baseUrl.trim()}|${settings.authMode}|${settings.instanceId.trim()}|${settings.tenant?.trim() ?? ""}|${settings.token}`
}

function selectorFor(metric: string, job: string | undefined): RuleSelector {
  return job === undefined ? { metric } : { metric, job }
}

function matches(rule: Rule, kind: Rule["kind"], metric: string, job: string | undefined) {
  return rule.kind === kind && rule.selector.metric === metric && rule.selector.job === job
}

function withoutImpacts(rules: Rule[]) {
  return rules.map((rule) => (rule.impact ? { ...rule, impact: undefined } : rule))
}

function withoutLogImpacts(rules: LogRule[]) {
  return rules.some((rule) => rule.impact) ? rules.map((rule) => (rule.impact ? { ...rule, impact: undefined } : rule)) : rules
}

function labelsOf(rule: Rule | undefined) {
  return rule?.kind === "drop_labels" ? rule.labels : []
}

/** Merges rules that share a selector within one status, keeping the first one's id. */
function foldStatus(rules: Rule[], status: RuleStatus) {
  const first = new Map<string, number>()
  const result: Rule[] = []
  for (const rule of rules) {
    if (rule.status !== status) {
      result.push(rule)
      continue
    }
    const key = ruleKey(rule)
    const index = first.get(key)
    if (index === undefined) {
      first.set(key, result.length)
      result.push(rule)
      continue
    }
    const kept = result[index]
    if (kept.kind === "drop_labels" && rule.kind === "drop_labels") {
      const labels = sortUnique([...kept.labels, ...rule.labels])
      if (labels.length !== kept.labels.length) result[index] = { ...kept, labels, impact: undefined }
    }
  }
  return result
}

function toggleMetric(rules: Rule[], metric: string, job: string | undefined): Rule[] {
  const same = rules.filter((rule) => matches(rule, "drop_metric", metric, job))
  const active = same.find((rule) => rule.status === "active")
  if (active) return rules.filter((rule) => rule !== active)
  // Turning on reuses a pending or rejected rule for the same selector.
  return activateOrCreate(rules, { kind: "drop_metric", selector: selectorFor(metric, job), origin: "user" })
}

function toggleLabel(rules: Rule[], metric: string, label: string, job: string | undefined): Rule[] {
  const same = rules.filter((rule) => matches(rule, "drop_labels", metric, job))
  const active = same.find((rule) => rule.status === "active")
  if (active?.kind === "drop_labels" && active.labels.includes(label)) {
    const labels = active.labels.filter((item) => item !== label)
    return labels.length === 0
      ? rules.filter((rule) => rule !== active)
      : rules.map((rule) => (rule === active ? { ...active, labels, impact: undefined } : rule))
  }
  // Turning on: the label moves out of any pending or rejected rule into the active one.
  const pending = same.find((rule) => rule.status !== "active" && labelsOf(rule).includes(label))
  if (!active && pending?.kind === "drop_labels" && pending.labels.length === 1) {
    return rules.map((rule) => (rule === pending ? { ...pending, status: "active" as const } : rule))
  }
  const next = rules.flatMap((rule): Rule[] => {
    if (rule.kind !== "drop_labels" || !same.includes(rule)) return [rule]
    if (rule === active) return [{ ...rule, labels: sortUnique([...rule.labels, label]), impact: undefined }]
    if (!rule.labels.includes(label)) return [rule]
    const labels = rule.labels.filter((item) => item !== label)
    return labels.length ? [{ ...rule, labels, impact: undefined }] : []
  })
  return active
    ? next
    : [...next, createRule({ kind: "drop_labels", selector: selectorFor(metric, job), labels: [label], origin: "user" })]
}

// Snapshots and rules from v2 marked series without a job as "(no job)".
function fromLegacyJob(job: string | undefined) {
  return job === LEGACY_NO_JOB ? "" : job
}

function migrateSnapshot(snapshot: Snapshot | null | undefined) {
  if (!snapshot) return snapshot ?? null
  const fixMetric = (metric: Snapshot["metrics"][number]) => ({
    ...metric,
    topJob: fromLegacyJob(metric.topJob),
    jobs: metric.jobs?.map((job) => fromLegacyJob(job) ?? job),
  })
  const seriesByMetricJob = snapshot.seriesByMetricJob
    ? Object.fromEntries(
        Object.entries(snapshot.seriesByMetricJob).map(([metric, byJob]) => [
          metric,
          Object.fromEntries(Object.entries(byJob).map(([job, count]) => [fromLegacyJob(job) ?? job, count])),
        ])
      )
    : undefined
  return {
    ...snapshot,
    seriesByMetricJob,
    jobs: snapshot.jobs.map((job) => ({ ...job, job: fromLegacyJob(job.job) ?? job.job })),
    metrics: snapshot.metrics.map(fixMetric),
    topMetrics: snapshot.topMetrics.map(fixMetric),
  }
}

function migrateRules(rules: Rule[] | undefined) {
  return (rules ?? []).map((rule) =>
    rule.selector.job === LEGACY_NO_JOB ? { ...rule, selector: { ...rule.selector, job: "" } } : rule
  )
}

type PersistedState = Partial<
  Pick<
    AppState,
    | "settings"
    | "snapshot"
    | "previousSnapshotSummary"
    | "snapshotSource"
    | "rules"
    | "relabelMode"
    | "tokenExpected"
    | "agentShareLabelValues"
    | "attribution"
    | "signal"
    | "logsSettings"
    | "logsSnapshot"
    | "previousLogsSnapshotSummary"
    | "logsSnapshotSource"
    | "logsTokenExpected"
    | "logRules"
    | "grafanaSettings"
    | "grafanaLinks"
  >
> & {
  snapshotOmitted?: boolean
  /** Before v5: the Teams feature, now attribution's custom owner rules. */
  teams?: unknown
}

/** Last page per signal lives for the tab only, like its history. */
const LAST_PATHS_KEY = "cardinal.nav.lastPaths"

function loadLastPaths(): Partial<Record<Signal, string>> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(LAST_PATHS_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([signal, path]) => isSignal(signal) && typeof path === "string" && signalFromPath(path.split(/[?#]/)[0]) === signal)
    )
  } catch {
    return {}
  }
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      snapshot: null,
      previousSnapshotSummary: null,
      snapshotSource: null,
      drilldowns: {},
      rules: [],
      relabelMode: "combined",
      activityLog: [],
      tokenExpected: false,
      authError: false,
      agentSession: null,
      agentStatus: "idle",
      agentActivity: [],
      agentPaused: false,
      agentShareLabelValues: true,
      snapshotProgress: null,

      updateSettings: (patch) =>
        set((state) => {
          const settings = { ...state.settings, ...patch }
          const tokenExpected = "token" in patch ? Boolean(settings.token) : state.tokenExpected
          if (connectionIdentity(settings) === connectionIdentity(state.settings)) return { settings, tokenExpected }
          return { settings, tokenExpected, drilldowns: {}, rules: withoutImpacts(state.rules), authError: false }
        }),
      switchConnection: (settings, snapshot) =>
        set((state) => {
          const next = { settings, snapshot, tokenExpected: Boolean(settings.token), authError: false }
          const source = snapshotSourceOf(settings)
          const history = { snapshotSource: source, previousSnapshotSummary: previousFor(state, snapshot, source) }
          if (connectionIdentity(settings) === connectionIdentity(state.settings)) return { ...next, ...history }
          return { ...next, ...history, drilldowns: {}, rules: withoutImpacts(state.rules) }
        }),
      setSnapshot: (snapshot) =>
        set((state) => {
          const source = snapshotSourceOf(state.settings)
          const history = { snapshotSource: snapshot ? source : null, previousSnapshotSummary: previousFor(state, snapshot, source) }
          return snapshot ? { snapshot, authError: false, ...history } : { snapshot, ...history }
        }),
      setAuthError: (authError) => set((state) => (state.authError === authError ? state : { authError })),
      cacheDrilldown: (drilldown) =>
        set((state) => ({ drilldowns: { ...state.drilldowns, [drilldown.metric]: drilldown } })),
      log: (message) =>
        set((state) => ({
          activityLog: [`[${new Date().toLocaleTimeString()}] ${message}`, ...state.activityLog].slice(0, 100),
        })),
      resetAll: () =>
        set({
          settings: defaultSettings,
          snapshot: null,
          previousSnapshotSummary: null,
          snapshotSource: null,
          drilldowns: {},
          rules: [],
          relabelMode: "combined",
          activityLog: [],
          tokenExpected: false,
          authError: false,
          snapshotProgress: null,
          agentShareLabelValues: true,
          attribution: DEFAULT_ATTRIBUTION,
          logsSettings: defaultLogsSettings,
          logsSnapshot: null,
          previousLogsSnapshotSummary: null,
          logsSnapshotSource: null,
          logsTokenExpected: false,
          logsAuthError: false,
          logsSnapshotProgress: null,
          logRules: [],
          grafanaSettings: DEFAULT_GRAFANA_SETTINGS,
          grafanaLinks: {},
        }),

      toggleDropMetric: (metric, job) => set((state) => ({ rules: toggleMetric(state.rules, metric, job) })),
      toggleDropLabel: (metric, label, job) => set((state) => ({ rules: toggleLabel(state.rules, metric, label, job) })),
      removeMetricRules: (metric) =>
        set((state) => ({
          rules: state.rules.filter((rule) => rule.status !== "active" || rule.selector.metric !== metric),
        })),
      removeRule: (id) => set((state) => ({ rules: state.rules.filter((rule) => rule.id !== id) })),
      clearRules: () => set((state) => ({ rules: state.rules.filter((rule) => rule.status === "proposed") })),
      addRules: (incoming) => {
        let result: AddRulesResult = { added: 0, skipped: 0 }
        set((state) => {
          const { rules, added, skipped } = mergeRules(state.rules, incoming)
          result = { added: added.length, skipped: skipped.length }
          return { rules }
        })
        return result
      },
      replaceRules: (incoming) => {
        let result: AddRulesResult = { added: 0, skipped: 0 }
        set((state) => {
          const kept = state.rules.filter((rule) => rule.status === "proposed")
          const { rules, added, skipped } = mergeRules(kept, incoming)
          result = { added: added.length, skipped: skipped.length }
          return { rules }
        })
        return result
      },
      setRuleStatus: (ids, status) =>
        set((state) => {
          const wanted = new Set(ids)
          const updated = state.rules.map((rule) => (wanted.has(rule.id) ? { ...rule, status } : rule))
          // Accepting a proposal folds it into an existing rule with the same selector and status.
          return { rules: foldStatus(updated, status) }
        }),
      setRuleImpact: (id, impact) =>
        set((state) => ({ rules: state.rules.map((rule) => (rule.id === id ? { ...rule, impact } : rule)) })),
      invalidateImpacts: () => set((state) => ({ rules: withoutImpacts(state.rules) })),
      setRelabelMode: (relabelMode) => set({ relabelMode }),

      setAgentSession: (agentSession) =>
        set({ agentSession, agentStatus: agentSession ? "connecting" : "idle", agentActivity: [], agentPaused: false }),
      setAgentStatus: (agentStatus) => set({ agentStatus }),
      recordAgentActivity: (activity) =>
        set((state) => ({ agentActivity: [activity, ...state.agentActivity].slice(0, 200) })),
      setAgentPaused: (agentPaused) => set({ agentPaused }),
      setAgentShareLabelValues: (agentShareLabelValues) => set({ agentShareLabelValues }),
      setSnapshotProgress: (snapshotProgress) => set({ snapshotProgress }),

      attribution: DEFAULT_ATTRIBUTION,
      setAttribution: (patch) => set((state) => ({ attribution: { ...state.attribution, ...patch } })),
      setOwners: (owners) => set((state) => ({ attribution: { ...state.attribution, owners } })),
      addOwner: (name, rules = []) => {
        const owner = createOwner(name, useAppStore.getState().attribution.owners.length, rules)
        set((state) => ({ attribution: { ...state.attribution, owners: [...state.attribution.owners, owner] } }))
        return owner
      },
      updateOwner: (id, patch) =>
        set((state) => ({
          attribution: { ...state.attribution, owners: state.attribution.owners.map((owner) => (owner.id === id ? { ...owner, ...patch, id } : owner)) },
        })),
      removeOwner: (id) =>
        set((state) => ({ attribution: { ...state.attribution, owners: state.attribution.owners.filter((owner) => owner.id !== id) } })),
      moveOwner: (id, delta) =>
        set((state) => {
          const from = state.attribution.owners.findIndex((owner) => owner.id === id)
          const to = from + delta
          if (from < 0 || to < 0 || to >= state.attribution.owners.length) return state
          const owners = [...state.attribution.owners]
          const [owner] = owners.splice(from, 1)
          owners.splice(to, 0, owner)
          return { attribution: { ...state.attribution, owners } }
        }),

      signal: "metrics",
      lastPathBySignal: typeof window === "undefined" ? {} : loadLastPaths(),
      visitPath: (path) =>
        set((state) => {
          const signal = signalFromPath(path.split(/[?#]/)[0])
          if (!signal) return state
          if (state.signal === signal && state.lastPathBySignal[signal] === path) return state
          const lastPathBySignal = { ...state.lastPathBySignal, [signal]: path }
          try {
            sessionStorage.setItem(LAST_PATHS_KEY, JSON.stringify(lastPathBySignal))
          } catch {
            // Storage blocked: remembering is best effort.
          }
          return { signal, lastPathBySignal }
        }),

      logsSettings: defaultLogsSettings,
      logsSnapshot: null,
      previousLogsSnapshotSummary: null,
      logsSnapshotSource: null,
      logsTokenExpected: false,
      logsAuthError: false,
      logsSnapshotProgress: null,
      updateLogsSettings: (patch) =>
        set((state) => {
          const logsSettings = { ...state.logsSettings, ...patch }
          const logsTokenExpected = "token" in patch ? Boolean(logsSettings.token) : state.logsTokenExpected
          if (connectionIdentity(logsSettings) === connectionIdentity(state.logsSettings)) return { logsSettings, logsTokenExpected }
          return { logsSettings, logsTokenExpected, logsAuthError: false, logRules: withoutLogImpacts(state.logRules) }
        }),
      switchLogsConnection: (logsSettings, logsSnapshot) =>
        set((state) => {
          const source = snapshotSourceOf(logsSettings)
          // Impacts were measured against the old backend (or an older snapshot): measure again.
          return {
            logRules: withoutLogImpacts(state.logRules),
            logsSettings,
            logsSnapshot,
            logsTokenExpected: Boolean(logsSettings.token),
            logsAuthError: false,
            logsSnapshotSource: source,
            previousLogsSnapshotSummary: previousLogsFor(state, logsSnapshot, source),
          }
        }),
      setLogsSnapshot: (logsSnapshot) =>
        set((state) => {
          const source = snapshotSourceOf(state.logsSettings)
          const history = {
            logsSnapshotSource: logsSnapshot ? source : null,
            previousLogsSnapshotSummary: previousLogsFor(state, logsSnapshot, source),
          }
          return logsSnapshot ? { logsSnapshot, logsAuthError: false, ...history } : { logsSnapshot, ...history }
        }),
      setLogsAuthError: (logsAuthError) => set((state) => (state.logsAuthError === logsAuthError ? state : { logsAuthError })),
      setLogsSnapshotProgress: (logsSnapshotProgress) => set({ logsSnapshotProgress }),

      logRules: [],
      addLogRules: (incoming) => {
        let result: AddRulesResult = { added: 0, skipped: 0 }
        set((state) => {
          const { rules, added, skipped } = mergeLogRules(state.logRules, incoming)
          result = { added: added.length, skipped: skipped.length }
          return { logRules: rules }
        })
        return result
      },
      setLogRuleStatus: (ids, status) =>
        set((state) => {
          const wanted = new Set(ids)
          // Accepting a proposal folds it into an existing rule with the same key and status.
          return { logRules: foldLogRules(state.logRules.map((rule) => (wanted.has(rule.id) ? { ...rule, status } : rule))) }
        }),
      setLogRuleImpact: (id, impact) =>
        set((state) => ({ logRules: state.logRules.map((rule) => (rule.id === id ? { ...rule, impact } : rule)) })),
      removeLogRule: (id) => set((state) => ({ logRules: state.logRules.filter((rule) => rule.id !== id) })),
      clearLogRules: () => set((state) => ({ logRules: state.logRules.filter((rule) => rule.status === "proposed") })),
      toggleLogRule: (candidate) => set((state) => ({ logRules: toggleLogRule(state.logRules, candidate) })),
      activateLogRule: (candidate) => set((state) => ({ logRules: activateOrCreateLogRule(state.logRules, candidate) })),
      invalidateLogImpacts: () => set((state) => ({ logRules: withoutLogImpacts(state.logRules) })),

      grafanaSettings: typeof window === "undefined" ? DEFAULT_GRAFANA_SETTINGS : (loadLegacyGrafana() ?? DEFAULT_GRAFANA_SETTINGS),
      grafanaLinks: {},
      updateGrafanaSettings: (patch) =>
        set((state) => {
          const grafanaSettings = { ...state.grafanaSettings, ...patch }
          if (bareUrl(grafanaSettings.baseUrl) !== bareUrl(state.grafanaSettings.baseUrl) && !("choices" in patch)) grafanaSettings.choices = {}
          return { grafanaSettings }
        }),
      setGrafanaLinks: (links) =>
        set((state) => {
          const grafanaLinks = { ...state.grafanaLinks }
          for (const [signal, link] of Object.entries(links) as Array<[Signal, GrafanaDatasourceLink | null]>) {
            if (link) grafanaLinks[signal] = link
            else delete grafanaLinks[signal]
          }
          return { grafanaLinks }
        }),
      disconnectSignal: (signal) => {
        const cleared = { baseUrl: "", authMode: "none" as const, instanceId: "", token: "", tenant: "" }
        const grafanaLinks = { ...get().grafanaLinks }
        delete grafanaLinks[signal]
        if (signal === "logs") {
          set((state) => ({
            logsSettings: { ...state.logsSettings, ...cleared },
            logsSnapshot: null,
            logsSnapshotSource: null,
            previousLogsSnapshotSummary: null,
            logsTokenExpected: false,
            logsAuthError: false,
            logRules: withoutLogImpacts(state.logRules),
            grafanaLinks,
          }))
        } else {
          set((state) => ({
            settings: { ...state.settings, ...cleared },
            snapshot: null,
            snapshotSource: null,
            previousSnapshotSummary: null,
            tokenExpected: false,
            authError: false,
            drilldowns: {},
            rules: withoutImpacts(state.rules),
            grafanaLinks,
          }))
        }
      },
    }),
    {
      name: PERSIST_KEY,
      version: 8,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state): PersistedState => ({
        settings: state.settings.rememberToken ? state.settings : { ...state.settings, token: "" },
        snapshot: state.snapshot,
        previousSnapshotSummary: state.previousSnapshotSummary,
        snapshotSource: state.snapshotSource,
        rules: state.rules,
        relabelMode: state.relabelMode,
        tokenExpected: state.tokenExpected,
        agentShareLabelValues: state.agentShareLabelValues,
        attribution: state.attribution,
        signal: state.signal,
        logsSettings: state.logsSettings.rememberToken ? state.logsSettings : { ...state.logsSettings, token: "" },
        logsSnapshot: state.logsSnapshot,
        previousLogsSnapshotSummary: state.previousLogsSnapshotSummary,
        logsSnapshotSource: state.logsSnapshotSource,
        logsTokenExpected: state.logsTokenExpected,
        logRules: state.logRules,
        grafanaSettings: state.grafanaSettings.rememberToken ? state.grafanaSettings : { ...state.grafanaSettings, token: "" },
        grafanaLinks: state.grafanaLinks,
      }),
      // Also used when another tab writes: keep this tab's in-memory token and,
      // when storage was full, its snapshot.
      merge: (persistedState, current) => {
        const { snapshotOmitted, ...persisted } = (persistedState ?? {}) as PersistedState
        const settings = { ...current.settings, ...persisted.settings }
        if (!settings.token && current.settings.token && settings.baseUrl.trim() === current.settings.baseUrl.trim()) {
          settings.token = current.settings.token
        }
        const sameConnection = connectionIdentity(settings) === connectionIdentity(current.settings)
        const logsSettings = { ...current.logsSettings, ...persisted.logsSettings }
        if (!logsSettings.token && current.logsSettings.token && logsSettings.baseUrl.trim() === current.logsSettings.baseUrl.trim()) {
          logsSettings.token = current.logsSettings.token
        }
        if (!isLogsRange(logsSettings.range)) logsSettings.range = DEFAULT_LOGS_RANGE
        const grafanaSettings = { ...current.grafanaSettings, ...persisted.grafanaSettings }
        if (!grafanaSettings.token && current.grafanaSettings.token && bareUrl(grafanaSettings.baseUrl) === bareUrl(current.grafanaSettings.baseUrl)) {
          grafanaSettings.token = current.grafanaSettings.token
        }
        if (!grafanaSettings.choices || typeof grafanaSettings.choices !== "object") grafanaSettings.choices = {}
        return {
          ...current,
          ...persisted,
          settings,
          snapshot: snapshotOmitted ? current.snapshot : (persisted.snapshot ?? null),
          rules: persisted.rules ?? current.rules,
          logRules: Array.isArray(persisted.logRules) ? persisted.logRules : current.logRules,
          signal: isSignal(persisted.signal) ? persisted.signal : current.signal,
          drilldowns: sameConnection ? current.drilldowns : {},
          logsSettings,
          logsSnapshot: snapshotOmitted ? current.logsSnapshot : (persisted.logsSnapshot ?? null),
          grafanaSettings,
          grafanaLinks: persisted.grafanaLinks && typeof persisted.grafanaLinks === "object" ? persisted.grafanaLinks : current.grafanaLinks,
        }
      },
      migrate: (persistedState, version) => {
        if (version < 2) {
          // v1 stored credentials unconditionally; start clean rather than import them.
          for (const key of ["cardinal.prometheus.connection", "cardinal.dashboard.session"]) {
            safeLocalStorage.removeItem(key)
          }
          return {}
        }
        const persisted = (persistedState ?? {}) as PersistedState
        // v3 had no auth mode: a username meant Basic (Grafana Cloud on grafana.net), a lone token was dropped.
        const settings =
          version < 4 && persisted.settings
            ? {
                ...persisted.settings,
                tenant: "",
                authMode: inferAuthMode({ ...persisted.settings, tokenExpected: persisted.tokenExpected }),
              }
            : persisted.settings
        // v4 had Teams: they become attribution's custom owner rules, enabled when there were any.
        const { teams, ...rest } = persisted
        const attribution = version < 5 ? migrateTeamsToAttribution({ teams, attribution: rest.attribution }) : rest.attribution
        // v6 added the logs connection; `merge` fills its defaults.
        // v7 added keep rules: the Patterns page's "Keep" had filed rejected drop_lines rules.
        const logRules = version < 7 && Array.isArray(rest.logRules) ? migrateKeepHacks(rest.logRules) : rest.logRules
        // v8 moved the usage scan's Grafana connection (its own store) here.
        const grafanaSettings = version < 8 ? (rest.grafanaSettings ?? loadLegacyGrafana() ?? undefined) : rest.grafanaSettings
        if (version < 8) safeLocalStorage.removeItem(LEGACY_GRAFANA_KEY)
        return {
          ...rest,
          settings,
          snapshot: migrateSnapshot(persisted.snapshot),
          rules: migrateRules(persisted.rules),
          ...(logRules ? { logRules } : {}),
          ...(attribution ? { attribution } : {}),
          ...(grafanaSettings ? { grafanaSettings } : {}),
        }
      },
    }
  )
)

// Another tab changed the saved state: pick it up instead of overwriting it later.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === PERSIST_KEY && event.storageArea === localStorage) void useAppStore.persist.rehydrate()
  })
}

/** Agent session secrets live for the tab only (sessionStorage), never in localStorage. */
const AGENT_SESSION_KEY = "cardinal.agent.session"

export function loadAgentSession(): CreatedSession | null {
  try {
    const raw = sessionStorage.getItem(AGENT_SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as CreatedSession
    return new Date(session.expiresAt).getTime() > Date.now() ? session : null
  } catch {
    return null
  }
}

export function storeAgentSession(session: CreatedSession | null) {
  try {
    if (session) sessionStorage.setItem(AGENT_SESSION_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(AGENT_SESSION_KEY)
  } catch {
    // ignore
  }
}

/** A signal's saved connection settings. */
export function connectionSettingsFor(signal: Signal, state: Pick<AppState, "settings" | "logsSettings"> = useAppStore.getState()): ConnectionSettings {
  return signal === "logs" ? state.logsSettings : state.settings
}

/**
 * The connection for a signal ("metrics" by default) or for the given
 * settings. Null when that signal has no base URL.
 */
export function currentConnection(from: ConnectionSettings | Signal = "metrics"): Connection | null {
  const settings = typeof from === "string" ? connectionSettingsFor(from) : from
  if (!settings.baseUrl.trim()) return null
  return {
    baseUrl: settings.baseUrl.trim(),
    auth: settings.authMode ?? inferAuthMode(settings),
    instanceId: settings.instanceId.trim() || undefined,
    token: settings.token || undefined,
    tenant: settings.tenant?.trim() || undefined,
    mode: settings.mode,
  }
}

/** True when the connection needs a token this tab doesn't have (e.g. after a reload with "remember token" off). */
export function needsToken(state: Pick<AppState, "settings" | "tokenExpected" | "authError">) {
  if (!state.settings.baseUrl.trim()) return false
  if (state.authError) return true
  if (state.settings.token) return false
  const mode = state.settings.authMode ?? inferAuthMode(state.settings)
  if (mode === "none") return false
  if (mode === "mimir") return state.tokenExpected
  return true
}

/** needsToken for the logs connection. */
export function needsLogsToken(state: Pick<AppState, "logsSettings" | "logsTokenExpected" | "logsAuthError">) {
  return needsToken({ settings: state.logsSettings, tokenExpected: state.logsTokenExpected, authError: state.logsAuthError })
}

/** Rules that apply in a view: global ones, plus the job's own when a job is given. */
function appliesIn(rule: Rule, job: string | undefined) {
  return rule.status === "active" && (rule.selector.job === undefined || (job !== undefined && rule.selector.job === job))
}

/** Active rules grouped the way the tables display selections, for all jobs or one job. */
export function selectionView(rules: Rule[], job?: string) {
  const dropMetrics = new Set<string>()
  const labelsByMetric: Record<string, Set<string>> = {}
  for (const rule of rules) {
    if (!appliesIn(rule, job)) continue
    if (rule.kind === "drop_metric") dropMetrics.add(rule.selector.metric)
    else if (rule.kind === "drop_labels") for (const label of rule.labels) (labelsByMetric[rule.selector.metric] ??= new Set()).add(label)
  }
  return {
    dropMetrics: Array.from(dropMetrics).sort(),
    selectedLabelsByMetric: Object.fromEntries(
      Object.entries(labelsByMetric).map(([metric, labels]) => [metric, sortUnique(labels)])
    ),
  }
}

/** The active rule dropping a metric in a view: the job's own rule first, then the global one. */
export function metricDropRule(rules: Rule[], metric: string, job?: string) {
  const candidates = rules.filter((rule) => rule.kind === "drop_metric" && rule.selector.metric === metric && appliesIn(rule, job))
  return candidates.find((rule) => rule.selector.job !== undefined) ?? candidates[0]
}

/** The active rule dropping a label of a metric in a view: the job's own rule first, then the global one. */
export function labelDropRule(rules: Rule[], metric: string, label: string, job?: string) {
  const candidates = rules.filter(
    (rule) => rule.kind === "drop_labels" && rule.selector.metric === metric && rule.labels.includes(label) && appliesIn(rule, job)
  )
  return candidates.find((rule) => rule.selector.job !== undefined) ?? candidates[0]
}
