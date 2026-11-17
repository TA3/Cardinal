import * as React from "react"

import { SavingsLine } from "@/components/savings-line"
import { useAutopilot } from "@/features/inbox/autopilot"
import { useServicesPatterns } from "@/features/logs/patterns-data"
import { patternTableRows } from "@/features/logs/pattern-table"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { useLogUsageEvidence } from "@/features/rules/log-usage"
import { formatBytes } from "@/lib/core/bytes"
import { applyPreference, learnedPreference, logRuleKeys } from "@/lib/core/decide/learn"
import { assessLog } from "@/lib/core/decide/risk"
import { adviseLogLabel } from "@/lib/core/logs/label-advice"
import { patternLineFilter } from "@/lib/core/logs/patterns"
import { MAX_LABEL_VALUES } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { summarizeLogRule, type LogUsageEvidence } from "@/lib/core/logs/logql-usage"
import {
  labelOpportunities,
  patternOpportunities,
  planLogOpportunities,
  type LogOpportunity,
  type OpportunityState,
} from "@/lib/core/opportunities"
import { useAppStore } from "@/lib/store/app-store"

// The logs Overview's lead, like the metrics one: noisy patterns and debug
// lines of the top services (one pattern query each, last hour) and stream
// labels to move to structured metadata (from the snapshot, no query).

const SERVICES = 5

/** Ranked log opportunities with their risk, and whether pattern queries are still running. */
export function useLogOpportunities(snapshot: LogsSnapshot | null) {
  const rules = useAppStore((state) => state.logRules)
  const decisions = useAppStore((state) => state.decisions)
  // Whether queries select by a label, for label moves (Loki rules and the LogQL dashboard scan).
  const { evidence } = useLogUsageEvidence(Boolean(snapshot))
  const groupLabel = snapshot?.groupLabel ?? ""
  const services = React.useMemo(
    () => (snapshot ? snapshot.groups.filter((group) => group.value !== "").slice(0, SERVICES).map((group) => group.value) : []),
    [snapshot]
  )
  const patterns = useServicesPatterns(groupLabel, services, "1h", Boolean(snapshot))
  const loading = patterns.some((query) => query.isPending && query.fetchStatus !== "idle")
  if (!snapshot) return { items: [], planned: [], loading: false }

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
  const planned = planLogOpportunities([...patternOpportunities(groupLabel, perService), ...labels], rules).map((item) => ({
    ...item,
    risk: applyPreference(assessLog(item, { labelQueried: labelQueried(item, evidence) }), learnedPreference(decisions, logRuleKeys(item.rule))),
  }))
  const items = planned.filter((item): item is (typeof planned)[number] & { state: OpportunityState } => item.state !== "active")
  return { items, planned, loading }
}

/** For a label move: true when a checked query selects by the label, false when rules and dashboards were both checked and none does. */
function labelQueried(item: LogOpportunity, evidence: LogUsageEvidence | null) {
  if (item.reason !== "labels" || item.rule.kind !== "label_to_metadata" || !evidence) return undefined
  const summary = summarizeLogRule({ kind: "label_to_metadata", selector: item.rule.selector, label: item.rule.label }, evidence)
  if (!summary) return undefined
  if (summary.used) return true
  return summary.unchecked.length === 0 ? false : undefined
}

/** Logs overview's line about Savings: how many cuts, what they save, and the way there. */
export function LogsSavingsLine({ snapshot }: { snapshot: LogsSnapshot }) {
  const propose = useProposeLogRule()
  const { items, loading } = useLogOpportunities(snapshot)
  const activeRules = useAppStore((state) => state.logRules.filter((rule) => rule.status === "active").length)
  const open = items.filter((item) => item.state === "open")
  const total = open.reduce((sum, item) => sum + (item.savedBytesPerDay ?? 0), 0)
  useAutopilot(items, loading, (item) => propose(item.rule, { quiet: true }))
  return (
    <SavingsLine
      loading={loading}
      open={open.length}
      safe={open.filter((item) => item.risk.level === "safe").length}
      total={total > 0 ? `−${formatBytes(total)}/day` : null}
      activeRules={activeRules}
    />
  )
}
