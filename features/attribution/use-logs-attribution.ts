import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { useAttributionChain, useAttributionSettings, useDebounced } from "@/features/attribution/use-attribution"
import { connectionKey, LOGS_META, useConnection } from "@/hooks/use-cardinality"
import type { Attribution } from "@/lib/core/attribution"
import { runWithConcurrency } from "@/lib/core/concurrency"
import {
  buildLogAttribution,
  logAttributionSelectors,
  logOwnerMatchers,
  ruleSplitSelectors,
  splitLogRuleSavings,
  volumeCells,
  volumeChainRows,
  type LogOwnerSavings,
  type RuleSplit,
} from "@/lib/core/logs/attribution"
import { snapshotLogImpact } from "@/lib/core/logs/impact"
import { activeLogRules, logRuleKey } from "@/lib/core/logs/rules"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { streamSelector } from "@/lib/core/logql"
import { queryableLabelRules, type LabelRuleRows } from "@/lib/core/owner-rules"
import { fetchIndexStats, fetchIndexVolume, timeRangeFor } from "@/lib/sources/loki"
import type { Connection } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

// Attribution of log bytes over the logs snapshot's range: one index/volume
// call by the chain labels, one for the bytes no chain label claims (per
// group value, for the custom rules), one per custom label rule, and
// index/stats for the largest owners' stream counts. All cached per
// connection, labels and snapshot.

const STALE = 10 * 60_000
const VOLUME_LIMIT = 5000
/** Owners that get a stream count (one index/stats call each, four at a time). */
export const STREAM_COUNT_OWNERS = 12

function rangeOf(snapshot: LogsSnapshot) {
  // The snapshot's own window, so shares line up with its totals.
  return timeRangeFor(snapshot.range, Date.parse(snapshot.capturedAt) || Date.now())
}

async function volumeByGroup(connection: Connection, selector: string, snapshot: LogsSnapshot, signal?: AbortSignal) {
  const rows = await fetchIndexVolume(connection, { text: selector }, { range: rangeOf(snapshot), targetLabels: [snapshot.groupLabel], limit: VOLUME_LIMIT, signal })
  return volumeCells(rows, snapshot.groupLabel)
}

export interface LogsAttributionState {
  attribution: Attribution
  loading: boolean
  loadingRules: number
  error: Error | null
  ruleErrors: Record<string, string>
  snapshot: LogsSnapshot
}

/** Attribution of the logs snapshot's bytes; null when disabled or without a logs snapshot. */
export function useLogsAttribution(): LogsAttributionState | null {
  const connection = useConnection("logs")
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const { enabled, owners } = useAttributionSettings()
  const chain = useAttributionChain()
  const key = connectionKey(connection)
  const capturedAt = snapshot?.capturedAt ?? null
  const active = Boolean(enabled && connection && snapshot)

  const chainQuery = useQuery({
    queryKey: ["logs-attribution-chain", key, chain, capturedAt],
    enabled: active && chain.length > 0,
    meta: LOGS_META,
    queryFn: async ({ signal }) => {
      // One call per level: index/volume only returns streams carrying every target label.
      const levels = await runWithConcurrency(
        chain,
        (label, index) =>
          fetchIndexVolume(connection!, { text: logAttributionSelectors.level(snapshot!.groupLabel, chain, index) }, {
            range: rangeOf(snapshot!),
            targetLabels: [label],
            limit: VOLUME_LIMIT,
            signal,
          }),
        3,
        signal
      )
      return volumeChainRows(levels.flat(), chain)
    },
    staleTime: STALE,
    retry: false,
  })
  const unlabelledQuery = useQuery({
    queryKey: ["logs-attribution-unlabelled", key, chain, capturedAt],
    enabled: active,
    meta: LOGS_META,
    queryFn: ({ signal }) =>
      volumeByGroup(connection!, chain.length ? logAttributionSelectors.unlabelled(snapshot!.groupLabel, chain) : logAttributionSelectors.all(snapshot!.groupLabel), snapshot!, signal),
    staleTime: STALE,
    retry: false,
  })

  // Custom label rules: one volume call each, run together (at most 4 at once).
  const settledOwners = useDebounced(owners, 600)
  const labelRules = React.useMemo(() => (enabled ? queryableLabelRules(settledOwners) : []), [settledOwners, enabled])
  const rulesQuery = useQuery({
    queryKey: ["logs-attribution-label-rules", key, chain, capturedAt, labelRules.map((rule) => rule.key)],
    enabled: active && labelRules.length > 0,
    meta: LOGS_META,
    queryFn: async ({ signal }) => {
      const rows: LabelRuleRows = {}
      const errors: Record<string, string> = {}
      await runWithConcurrency(
        labelRules,
        async (rule) => {
          try {
            rows[rule.key] = await volumeByGroup(connection!, logAttributionSelectors.labelRule(snapshot!.groupLabel, chain, rule.label, rule.pattern), snapshot!, signal)
          } catch (error) {
            if (signal.aborted) throw error
            errors[rule.key] = error instanceof Error ? error.message : String(error)
          }
        },
        4,
        signal
      )
      return { rows, errors }
    },
    staleTime: STALE,
    retry: false,
  })

  return React.useMemo(() => {
    if (!enabled || !snapshot) return null
    const chainRows = chain.length ? chainQuery.data : []
    const ready = Boolean(chainRows && unlabelledQuery.data)
    const attribution = buildLogAttribution({
      chain,
      chainRows: chainRows ?? [],
      unlabelled: { cells: unlabelledQuery.data ?? [], exact: true },
      owners,
      labelRows: rulesQuery.data?.rows ?? {},
    })
    return {
      attribution,
      loading: !ready && !chainQuery.error && !unlabelledQuery.error,
      loadingRules: labelRules.length && rulesQuery.isPending && active ? labelRules.length : 0,
      error: chainQuery.error ?? unlabelledQuery.error ?? null,
      ruleErrors: rulesQuery.data?.errors ?? {},
      snapshot,
    }
  }, [enabled, snapshot, chain, owners, chainQuery.data, chainQuery.error, unlabelledQuery.data, unlabelledQuery.error, rulesQuery.data, rulesQuery.isPending, labelRules, active])
}

/** Stream counts of the largest label owners, by owner id. */
export function useLogOwnerStreams(state: LogsAttributionState | null) {
  const connection = useConnection("logs")
  const chain = useAttributionChain()
  const owners = React.useMemo(
    () =>
      (state?.attribution.owners ?? [])
        .filter((owner) => owner.source === "label" && owner.dimension !== undefined)
        .slice(0, STREAM_COUNT_OWNERS)
        .map((owner) => ({ id: owner.id, dimension: owner.dimension!, value: owner.name })),
    [state?.attribution.owners]
  )
  const snapshot = state?.snapshot
  return useQuery({
    queryKey: ["logs-attribution-streams", connectionKey(connection), chain, snapshot?.capturedAt ?? null, owners.map((owner) => owner.id)],
    enabled: Boolean(connection && snapshot && owners.length),
    meta: LOGS_META,
    queryFn: async ({ signal }) => {
      const result: Record<string, number> = {}
      await runWithConcurrency(
        owners,
        async (owner) => {
          const stats = await fetchIndexStats(connection!, { text: streamSelector(logOwnerMatchers(chain, owner.dimension, owner.value)) }, { range: rangeOf(snapshot!), signal })
          result[owner.id] = stats.streams
        },
        4,
        signal
      )
      return result
    },
    staleTime: STALE,
    retry: false,
  })
}

/**
 * Active log rules' byte savings per owner: each rule's streams are split
 * between owners with index/volume (one call per chain level plus one for the
 * unclaimed part, four at a time), then its saving is shared out.
 */
export function useLogOwnerSavings(state: LogsAttributionState | null) {
  const connection = useConnection("logs")
  const logRules = useAppStore((store) => store.logRules)
  const snapshot = state?.snapshot ?? null
  const chain = state?.attribution.chain
  // Only rules that save bytes need a split.
  const measured = React.useMemo(
    () =>
      activeLogRules(logRules).filter((rule) => {
        const impact = rule.impact ?? snapshotLogImpact(rule, snapshot)
        return impact !== null && impact.bytesBefore > impact.bytesAfter
      }),
    [logRules, snapshot]
  )
  const targets = React.useMemo(
    () =>
      snapshot && chain
        ? measured.flatMap((rule) => {
            const selectors = ruleSplitSelectors(rule, snapshot.groupLabel, chain)
            return selectors ? [{ id: rule.id, key: logRuleKey(rule), selectors }] : []
          })
        : [],
    [measured, snapshot, chain]
  )
  const splits = useQuery({
    queryKey: ["logs-attribution-rule-splits", connectionKey(connection), chain, snapshot?.capturedAt ?? null, targets.map((target) => target.key)],
    enabled: Boolean(connection && snapshot && chain && targets.length),
    meta: LOGS_META,
    queryFn: async ({ signal }) => {
      const jobs = targets.flatMap((target) => [
        ...target.selectors.levels.map((selector, level) => ({ target, selector, label: chain![level], level })),
        { target, selector: target.selectors.unlabelled, label: snapshot!.groupLabel, level: -1 },
      ])
      const rows = await runWithConcurrency(
        jobs,
        (job) => fetchIndexVolume(connection!, { text: job.selector }, { range: rangeOf(snapshot!), targetLabels: [job.label], limit: VOLUME_LIMIT, signal }),
        4,
        signal
      )
      const byKey: Record<string, RuleSplit> = {}
      jobs.forEach((job, index) => {
        const split = (byKey[job.target.key] ??= { levels: chain!.map(() => []), unlabelled: [] })
        if (job.level < 0) split.unlabelled = rows[index]
        else split.levels[job.level] = rows[index]
      })
      return byKey
    },
    staleTime: STALE,
    retry: false,
  })
  return React.useMemo(() => {
    if (!state) return { byOwner: new Map<string, LogOwnerSavings>(), pending: 0, loading: false }
    const byId: Record<string, RuleSplit | undefined> = {}
    for (const target of targets) byId[target.id] = splits.data?.[target.key]
    const result = splitLogRuleSavings(state.attribution, logRules, state.snapshot, byId)
    return { ...result, loading: splits.isFetching }
  }, [state, targets, splits.data, splits.isFetching, logRules])
}
