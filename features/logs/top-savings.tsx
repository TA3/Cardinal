import * as React from "react"
import { Link } from "react-router"

import { logGroupPath, logLabelPath, paths } from "@/app/paths"
import { useBytesCost } from "@/components/cost-text"
import { SavingsList, type SavingsRowProps } from "@/components/savings-list"
import { Button } from "@/components/ui/button"
import { useServicesPatterns } from "@/features/logs/patterns-data"
import { patternTableRows } from "@/features/logs/pattern-table"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { applyPreference, learnedPreference, logRuleKeys } from "@/lib/core/decide/learn"
import { assessLog } from "@/lib/core/decide/risk"
import { adviseLogLabel } from "@/lib/core/logs/label-advice"
import { patternLineFilter, patternPreview } from "@/lib/core/logs/patterns"
import { MAX_LABEL_VALUES } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { LOG_REASON_LABEL, labelOpportunities, patternOpportunities, rankLogOpportunities } from "@/lib/core/opportunities"
import { useAppStore } from "@/lib/store/app-store"

// The logs Overview's lead, like the metrics one: noisy patterns and debug
// lines of the top services (one pattern query each, last hour) and stream
// labels to move to structured metadata (from the snapshot, no query).

const SERVICES = 5

/** Ranked log opportunities with their risk, and whether pattern queries are still running. */
export function useLogOpportunities(snapshot: LogsSnapshot | null) {
  const rules = useAppStore((state) => state.logRules)
  const decisions = useAppStore((state) => state.decisions)
  const groupLabel = snapshot?.groupLabel ?? ""
  const services = React.useMemo(
    () => (snapshot ? snapshot.groups.filter((group) => group.value !== "").slice(0, SERVICES).map((group) => group.value) : []),
    [snapshot]
  )
  const patterns = useServicesPatterns(groupLabel, services, "1h", Boolean(snapshot))
  const loading = patterns.some((query) => query.isPending && query.fetchStatus !== "idle")
  if (!snapshot) return { items: [], loading: false }

  // Cheap enough per render (a few services' patterns); the query results are a new array every render anyway.
  const perService = patterns.map((query) => ({
    service: query.service,
    patterns: patternTableRows(snapshot, groupLabel, query.service, query.data).rows.map((row) => ({
      pattern: row.pattern,
      level: row.level,
      lineShare: row.lineShare,
      bytesPerDay: row.bytesPerDay,
      regex: patternLineFilter(row.pattern)?.regex ?? null,
    })),
  }))
  const labels = labelOpportunities(
    snapshot.labels.map((label) => {
      const truncated = Boolean(snapshot.labelsTruncated && label.distinctValues >= MAX_LABEL_VALUES)
      const advice = adviseLogLabel({ label: label.label, distinctValues: label.distinctValues, idLike: label.idLike, truncated })
      return { ...label, move: advice.kind === "label_to_metadata" && advice.strength === "strong" }
    })
  )
  const items = rankLogOpportunities([...patternOpportunities(groupLabel, perService), ...labels], rules).map((item) => ({
    ...item,
    risk: applyPreference(assessLog(item), learnedPreference(decisions, logRuleKeys(item.rule))),
  }))
  return { items, loading }
}

type RankedLogOpportunity = ReturnType<typeof useLogOpportunities>["items"][number]

/** One Top savings row per log opportunity. */
export function logSavingsRows(
  items: RankedLogOpportunity[],
  propose: ReturnType<typeof useProposeLogRule>,
  format: (bytes: number, per?: string) => string | null
): SavingsRowProps[] {
  return items.map((item) => ({
    id: item.id,
    reason: LOG_REASON_LABEL[item.reason],
    titleText: item.reason === "noisy" ? `${item.subtitle}: ${item.title}` : item.title,
    title: item.reason === "noisy" ? patternPreview(item.title, 80) : item.title,
    detail: item.reason === "noisy" ? item.subtitle : item.reason === "labels" ? item.subtitle : "debug + trace",
    to: item.reason === "labels" ? logLabelPath(item.title) : logGroupPath(item.reason === "noisy" ? (item.subtitle ?? "") : item.title),
    saving:
      item.savedBytesPerDay !== null
        ? `~−${formatBytes(item.savedBytesPerDay)}/day`
        : item.savedStreams
          ? `~−${formatNumber(item.savedStreams)} streams`
          : "to metadata",
    cost: item.savedBytesPerDay !== null ? (format(item.savedBytesPerDay, "day") ?? undefined) : undefined,
    state: item.state,
    risk: item.risk,
    onPropose: () => {
      propose(item.rule, { success: "Proposed" })
    },
  }))
}

export function LogsTopSavings({ snapshot, className }: { snapshot: LogsSnapshot; className?: string }) {
  const propose = useProposeLogRule()
  const { format } = useBytesCost()
  const { items, loading } = useLogOpportunities(snapshot)

  const open = items.filter((item) => item.state === "open" && item.savedBytesPerDay)
  const total = open.reduce((sum, item) => sum + (item.savedBytesPerDay ?? 0), 0)
  const rows = logSavingsRows(items, propose, format)

  return (
    <SavingsList
      className={className}
      rows={rows}
      loading={loading}
      total={total > 0 ? `up to −${formatBytes(total)}/day` : undefined}
      empty={{
        title: "Nothing obvious to cut",
        description: "No noisy patterns, debug lines or runaway labels in the top services.",
        action: (
          <Button asChild variant="outline" size="sm">
            <Link to={paths.logVolume}>Open volume</Link>
          </Button>
        ),
      }}
    />
  )
}
