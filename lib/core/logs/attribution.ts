// Attribution for logs: who owns the bytes and streams. The same model as
// lib/core/attribution.ts (Primary, Secondary, Third label, then custom owner
// rules, then Unattributed), fed with Loki's index/volume rows instead of
// PromQL counts: the "series" of the shared model are bytes here. Custom rules
// map to logs as follows: job rules match the snapshot's group label (usually
// service_name), label rules match stream labels, metric-prefix rules don't apply.

import { buildAttribution, labelOwnerId, type Attribution, type AttributionInput, type ChainRow } from "@/lib/core/attribution"
import { snapshotLogImpact } from "@/lib/core/logs/impact"
import { activeLogRules, logRuleShadowedBy } from "@/lib/core/logs/rules"
import type { LabelMatcher, LogRule, LogsSnapshot } from "@/lib/core/logs/types"
import { assertLokiLabelName, streamSelector } from "@/lib/core/logql"
import type { Owner, OwnershipRule } from "@/lib/core/owner-rules"
import { regexProblem } from "@/lib/core/regex"

export interface LogVolumeRow {
  labels: Record<string, string>
  bytes: number
}

/** Streams that carry the group label: the attribution universe, `{service_name=~".+"}`. */
export function groupMatcher(groupLabel: string): LabelMatcher {
  return { label: assertLokiLabelName(groupLabel), op: "=~", value: ".+" }
}

const unset = (label: string): LabelMatcher => ({ label: assertLokiLabelName(label), op: "=", value: "" })

export const logAttributionSelectors = {
  /** Everything (streams with the group label). */
  all: (groupLabel: string) => streamSelector([groupMatcher(groupLabel)]),
  /**
   * Streams resolved at chain level `index`: without any earlier chain label.
   * Loki's index/volume only returns streams carrying every target label, so
   * each level is its own call with targetLabels = [chain[index]].
   */
  level: (groupLabel: string, chain: string[], index: number) => streamSelector([groupMatcher(groupLabel), ...chain.slice(0, index).map(unset)]),
  /** Streams without any chain label, for bytes per group value (the custom rules' cells). */
  unlabelled: (groupLabel: string, chain: string[]) => streamSelector([groupMatcher(groupLabel), ...chain.map(unset)]),
  /** Streams a custom label rule claims among the unlabelled ones. */
  labelRule: (groupLabel: string, chain: string[], label: string, pattern: string) => {
    const problem = regexProblem(pattern)
    if (problem) throw new Error(`Invalid pattern ${JSON.stringify(pattern)}: ${problem}`)
    return streamSelector([groupMatcher(groupLabel), ...chain.map(unset), { label: assertLokiLabelName(label), op: "=~", value: pattern }])
  },
}

/** Matchers of a label owner: earlier chain labels unset, its own label equal. */
export function logOwnerMatchers(chain: string[], dimension: number, value: string): LabelMatcher[] {
  const label = chain[dimension]
  if (label === undefined) throw new Error(`No attribution label at level ${dimension + 1}`)
  return [...chain.slice(0, dimension).map(unset), { label: assertLokiLabelName(label), op: "=", value }]
}

/** index/volume rows (one chain level each) as the shared model's chain rows, bytes in place of series. */
export function volumeChainRows(rows: LogVolumeRow[], chain: string[]): ChainRow[] {
  return rows.map((row) => ({ labels: Object.fromEntries(chain.map((label) => [label, row.labels[label] ?? ""])), seriesCount: row.bytes }))
}

/** Bytes per group value as job×metric cells ("job" = the group value, no metric). */
export function volumeCells(rows: LogVolumeRow[], groupLabel: string) {
  return rows.map((row) => ({ job: row.labels[groupLabel] ?? "", metric: "", seriesCount: row.bytes }))
}

/** Owners with only the rules that make sense for logs (no metric prefixes). */
export function logOwners(owners: Owner[]): Owner[] {
  return owners.map((owner) => ({ ...owner, rules: owner.rules.filter((rule: OwnershipRule) => rule.kind !== "metric_prefix") }))
}

export type LogAttributionInput = Omit<AttributionInput, "owners"> & { owners: Owner[] }

/** Attribution of log bytes; `totalSeries`, `series` and `percent` are bytes and shares of bytes. */
export function buildLogAttribution(input: LogAttributionInput): Attribution {
  return buildAttribution({ ...input, owners: logOwners(input.owners) })
}

// ---- rule savings per owner ----

/**
 * Selectors that split one rule's streams between owners: per chain level
 * (the rule's matchers plus that level's, by targetLabels = [chain[level]]),
 * and the part no chain label claims (by the group label, for rule owners and
 * Unattributed). Null for a rule whose selector can't be rendered.
 */
export function ruleSplitSelectors(rule: Pick<LogRule, "selector">, groupLabel: string, chain: string[]) {
  const own = rule.selector.matchers
  const build = (extra: LabelMatcher[]) => {
    try {
      return streamSelector([...own, ...extra])
    } catch {
      return null
    }
  }
  const levels = chain.map((_, index) => build([groupMatcher(groupLabel), ...chain.slice(0, index).map(unset)]))
  const unlabelled = build([groupMatcher(groupLabel), ...chain.map(unset)])
  if (!unlabelled || levels.some((item) => item === null)) return null
  return { levels: levels as string[], unlabelled }
}

/** Where one rule's bytes sit: rows per chain level, and the unclaimed part by group value. */
export interface RuleSplit {
  levels: LogVolumeRow[][]
  unlabelled: LogVolumeRow[]
}

export interface LogOwnerSavings {
  savedBytes: number
  /** Rules that touch the owner, with the bytes each saves it. */
  rules: Array<{ rule: LogRule; savedBytes: number }>
  isEstimate: boolean
}

/**
 * Bytes the active rules save each owner: every rule's saving is split in
 * proportion to where its streams' bytes sit (from `splits`, index/volume of
 * the rule's selector per chain level and per group value). Custom-rule owners
 * and Unattributed get a group value's share by the bytes they own of it.
 * Line rules assume their lines are spread like the streams' bytes, so
 * anything but a stream drop is an estimate. Rules without a split yet are
 * left out (`pending`).
 */
export function splitLogRuleSavings(
  attribution: Pick<Attribution, "chain" | "owners" | "unattributed">,
  logRules: LogRule[],
  snapshot: LogsSnapshot | null,
  splits: Record<string, RuleSplit | undefined>
): { byOwner: Map<string, LogOwnerSavings>; pending: number } {
  const active = activeLogRules(logRules)
  const owners = [...attribution.owners, attribution.unattributed]
  const byOwner = new Map<string, LogOwnerSavings>(owners.map((owner) => [owner.id, { savedBytes: 0, rules: [], isEstimate: false }]))
  // Group value → bytes each custom-rule owner (or Unattributed) holds of it.
  const cellOwners = new Map<string, Array<{ id: string; bytes: number }>>()
  for (const owner of owners) {
    for (const [value, bytes] of owner.ownership?.cells.get("") ?? []) {
      const list = cellOwners.get(value) ?? []
      cellOwners.set(value, list)
      list.push({ id: owner.id, bytes })
    }
  }
  let pending = 0
  for (const rule of active) {
    if (logRuleShadowedBy(rule, active)) continue
    const impact = rule.impact ?? snapshotLogImpact(rule, snapshot)
    const saved = impact ? Math.max(0, impact.bytesBefore - impact.bytesAfter) : 0
    if (!impact || saved <= 0 || impact.bytesBefore <= 0) continue
    const split = splits[rule.id]
    if (!split) {
      pending += 1
      continue
    }
    const estimate = !impact.exact || rule.kind !== "drop_streams"
    const shares = new Map<string, number>()
    const add = (id: string, bytes: number) => shares.set(id, (shares.get(id) ?? 0) + bytes)
    split.levels.forEach((rows, level) => {
      for (const row of rows) {
        const value = row.labels[attribution.chain[level]] ?? ""
        if (value) add(labelOwnerId(level, value), row.bytes)
      }
    })
    for (const row of split.unlabelled) {
      const list = cellOwners.get(Object.values(row.labels)[0] ?? "") ?? []
      const total = list.reduce((sum, item) => sum + item.bytes, 0)
      for (const item of list) if (total > 0) add(item.id, (row.bytes * item.bytes) / total)
    }
    // Index reads differ slightly between calls: shares are of what the split saw, capped at the rule's own bytes.
    const seen = Math.max(impact.bytesBefore, Array.from(shares.values()).reduce((sum, bytes) => sum + bytes, 0))
    for (const [id, bytes] of shares) {
      const target = byOwner.get(id)
      if (!target || bytes <= 0) continue
      const mine = Math.round((saved * bytes) / seen)
      if (mine <= 0) continue
      target.rules.push({ rule, savedBytes: mine })
      target.savedBytes += mine
      if (estimate) target.isEstimate = true
    }
  }
  for (const owner of owners) {
    const target = byOwner.get(owner.id)!
    target.savedBytes = Math.min(target.savedBytes, owner.series)
    target.rules.sort((a, b) => b.savedBytes - a.savedBytes)
  }
  return { byOwner, pending }
}
