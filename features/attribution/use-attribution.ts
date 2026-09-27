import * as React from "react"
import { useQueries, useQuery } from "@tanstack/react-query"

import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import {
  attributionChain,
  buildAttribution,
  jobOwnersFromChain,
  type Attribution,
  type AttributedOwner,
} from "@/lib/core/attribution"
import {
  assignOwnership,
  jobOwners,
  queryableLabelRules,
  ruleOwnerSavings,
  snapshotCells,
  type LabelRuleRows,
  type Owner,
  type OwnerSavings,
} from "@/lib/core/owner-rules"
import {
  fetchChainRows,
  fetchJobChainRows,
  fetchLabelRuleRows,
  fetchOwnerDrilldown,
  fetchSeriesByLabelValue,
  fetchUnlabelledCells,
} from "@/lib/sources/attribution"
import { fetchLabelNames, type SnapshotProgress } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

// Attribution of the loaded snapshot. The label chain and the unlabelled
// job×metric cells are one query each (per job on large tenants), cached per
// connection, labels and snapshot; custom label rules run one query each.

/** `value`, once it has stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay: number) {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

export function useAttributionSettings() {
  return useAppStore((state) => state.attribution)
}

export function useAttributionEnabled() {
  return useAppStore((state) => state.attribution.enabled)
}

/** The resolved label chain, stable while the labels don't change. */
export function useAttributionChain() {
  const labels = useAppStore((state) => state.attribution.labels)
  const key = labels.join("\u0000")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => attributionChain(labels), [key])
}

const STALE = 10 * 60_000

function useLabelRuleRows(owners: Owner[], chain: string[], capturedAt: string | undefined, enabled: boolean) {
  const connection = useConnection()
  // Typing a label rule's pattern must not send a query per keystroke.
  const settledOwners = useDebounced(owners, 600)
  const rules = React.useMemo(() => (enabled ? queryableLabelRules(settledOwners) : []), [settledOwners, enabled])
  const results = useQueries({
    queries: rules.map((rule) => ({
      queryKey: ["owner-label-rule", connectionKey(connection), chain, rule.key, capturedAt ?? null],
      enabled: Boolean(connection),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchLabelRuleRows(connection!, chain, rule, signal),
      staleTime: STALE,
      retry: false,
    })),
  })
  const stamp = results.map((result) => `${result.status}:${result.dataUpdatedAt}`).join("|")
  return React.useMemo(() => {
    const rows: LabelRuleRows = {}
    const errors: Record<string, string> = {}
    let loading = 0
    rules.forEach((rule, index) => {
      const result = results[index]
      if (result?.data) rows[rule.key] = result.data
      else if (result?.error) errors[rule.key] = result.error.message
      else if (connection) loading += 1
    })
    return { rows, errors, loading }
    // `stamp` changes whenever a result does; `results` itself is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, stamp, connection])
}

export interface AttributionState {
  attribution: Attribution
  /** Chain or unlabelled queries still running. */
  loading: boolean
  /** Custom label rules still loading. */
  loadingRules: number
  error: Error | null
  /** Per-job fallback progress on large tenants. */
  progress: SnapshotProgress | null
  /** Failed custom label rules by key. */
  ruleErrors: Record<string, string>
  skippedJobs: string[]
}

/** Attribution of the current snapshot; null when disabled or without a snapshot. */
export function useAttribution(): AttributionState | null {
  const connection = useConnection()
  const snapshot = useAppStore((state) => state.snapshot)
  const { enabled, owners } = useAttributionSettings()
  const chain = useAttributionChain()
  const [progress, setProgress] = React.useState<SnapshotProgress | null>(null)
  const capturedAt = snapshot?.capturedAt ?? null
  const jobs = React.useMemo(() => snapshot?.jobs.map((job) => job.job) ?? [], [snapshot])
  const active = Boolean(enabled && connection && snapshot && chain.length)
  const key = connectionKey(connection)

  const chainQuery = useQuery({
    queryKey: ["attribution-chain", key, chain, capturedAt],
    enabled: active,
    queryFn: async ({ signal }) => {
      try {
        return await fetchChainRows(connection!, chain, { signal, jobs, onStep: setProgress })
      } finally {
        setProgress(null)
      }
    },
    staleTime: STALE,
    retry: false,
  })
  const unlabelledQuery = useQuery({
    queryKey: ["attribution-unlabelled", key, chain, capturedAt],
    enabled: active,
    queryFn: ({ signal }) => fetchUnlabelledCells(connection!, chain, { signal, jobs }),
    staleTime: STALE,
    retry: false,
  })
  const labelRules = useLabelRuleRows(owners, chain, snapshot?.capturedAt, enabled)

  return React.useMemo(() => {
    if (!enabled || !snapshot) return null
    const unlabelled = chain.length ? (unlabelledQuery.data ? { cells: unlabelledQuery.data.rows, exact: true } : null) : snapshotCells(snapshot)
    const chainRows = chain.length ? chainQuery.data?.rows : []
    const ready = Boolean(unlabelled && chainRows)
    const attribution = buildAttribution({
      chain,
      chainRows: chainRows ?? [],
      unlabelled: unlabelled ?? { cells: [], exact: true },
      owners,
      labelRows: labelRules.rows,
    })
    return {
      attribution,
      loading: !ready && !chainQuery.error && !unlabelledQuery.error,
      loadingRules: labelRules.loading,
      error: chainQuery.error ?? unlabelledQuery.error ?? null,
      progress,
      ruleErrors: labelRules.errors,
      skippedJobs: [...new Set([...(chainQuery.data?.skippedJobs ?? []), ...(unlabelledQuery.data?.skippedJobs ?? [])])],
    }
  }, [enabled, snapshot, chain, owners, chainQuery.data, chainQuery.error, unlabelledQuery.data, unlabelledQuery.error, labelRules, progress])
}

/** Exact active-rule savings for custom rule owners and Unattributed, by id. */
export function useRuleOwnerSavings(attribution: Attribution | null): Map<string, OwnerSavings> {
  const snapshot = useAppStore((state) => state.snapshot)
  const rules = useAppStore((state) => state.rules)
  const drilldowns = useAppStore((state) => state.drilldowns)
  return React.useMemo(() => {
    const result = new Map<string, OwnerSavings>()
    if (!snapshot || !attribution) return result
    for (const owner of [...attribution.owners, attribution.unattributed]) {
      if (owner.ownership) result.set(owner.id, ruleOwnerSavings(snapshot, owner.ownership, rules, drilldowns))
    }
    return result
  }, [snapshot, attribution, rules, drilldowns])
}

export function ownerDrilldownKey(connection: ReturnType<typeof useConnection>, chain: string[], owner: Pick<AttributedOwner, "dimension" | "name">, capturedAt?: string) {
  return ["attribution-owner", connectionKey(connection), chain, owner.dimension ?? -1, owner.name, capturedAt ?? null]
}

/** A label owner's top metrics and next-label breakdown; loads once `enabled`, then stays cached. */
export function useOwnerDrilldown(owner: AttributedOwner, enabled: boolean) {
  const connection = useConnection()
  const chain = useAttributionChain()
  const capturedAt = useAppStore((state) => state.snapshot?.capturedAt)
  return useQuery({
    queryKey: ownerDrilldownKey(connection, chain, owner, capturedAt),
    enabled: enabled && Boolean(connection) && owner.source === "label" && owner.dimension !== undefined,
    queryFn: ({ signal }) => fetchOwnerDrilldown(connection!, chain, owner.dimension!, owner.name, signal),
    staleTime: STALE,
    retry: false,
  })
}

/**
 * Owners of each job, largest first, for the badges on jobs. Null when
 * attribution is off, or when the one `count by (job, labels)` query failed.
 */
export function useJobOwners() {
  const connection = useConnection()
  const snapshot = useAppStore((state) => state.snapshot)
  const { enabled, owners } = useAttributionSettings()
  const chain = useAttributionChain()
  const labelRules = useLabelRuleRows(owners, chain, snapshot?.capturedAt, enabled && chain.length === 0)
  const { data } = useQuery({
    queryKey: ["attribution-job-owners", connectionKey(connection), chain, snapshot?.capturedAt ?? null],
    enabled: Boolean(enabled && connection && snapshot && chain.length),
    queryFn: ({ signal }) => fetchJobChainRows(connection!, chain, signal),
    staleTime: STALE,
    retry: false,
  })
  return React.useMemo(() => {
    if (!enabled || !snapshot) return null
    if (chain.length === 0) return owners.length ? jobOwners(assignOwnership(snapshot, owners, labelRules.rows)) : null
    return data ? jobOwnersFromChain(data, chain, owners) : null
  }, [enabled, snapshot, chain, owners, labelRules.rows, data])
}

/** Series per value of a label across all metrics, for the rule editor's preview. */
export function useLabelValueSeries(label: string | null) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["owner-label-values", connectionKey(connection), label],
    enabled: Boolean(connection && label),
    queryFn: ({ signal }) => fetchSeriesByLabelValue(connection!, label!, { limit: 50, signal }),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** The backend's label names (shared with the search box's cache). */
export function useLabelNames(enabled = true) {
  const connection = useConnection()
  const { data, isPending, error } = useQuery({
    queryKey: ["label-names", connectionKey(connection)],
    enabled: enabled && Boolean(connection),
    queryFn: ({ signal }) => fetchLabelNames(connection!, undefined, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const names = React.useMemo(() => (data ?? []).filter((name) => !name.startsWith("__")), [data])
  return { names: data ? names : null, isPending: Boolean(connection) && isPending, error }
}
