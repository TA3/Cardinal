import type { Assessment } from "@/lib/core/decide/risk"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { perDay } from "@/lib/core/logs/volume"
import type { LogOpportunity, OpportunityState } from "@/lib/core/opportunities"

// The logs half of the Plan: cuts grouped by service (the snapshot's group
// label), so a service is decided as a whole, like a scrape job on the
// metrics side. Label moves apply to every stream, so they sit in their own
// group at the end.

export type LogCutState = OpportunityState | "active"

export type LogPlanCut<T extends LogOpportunity = LogOpportunity> = T & { state: LogCutState; risk: Assessment }

export interface LogServicePlan<T extends LogOpportunity = LogOpportunity> {
  /** null: cuts that apply to every service (label moves). */
  service: string | null
  bytesPerDay: number
  /** Share of all bytes, 0–100. */
  share: number
  cuts: LogPlanCut<T>[]
  /** Bytes per day the cuts not in the plan yet save. */
  openSavings: number
  /** The same for every cut, so services keep their place as cuts are added. */
  totalSavings: number
}

/** The service an opportunity belongs to; null for label moves on every stream. */
export function opportunityService(item: Pick<LogOpportunity, "reason" | "title" | "subtitle">) {
  if (item.reason === "debug") return item.title
  if (item.reason === "noisy") return item.subtitle ?? null
  return null
}

const REASON_RANK: Record<LogOpportunity["reason"], number> = { debug: 0, noisy: 1, labels: 2 }

export function buildLogsPlan<T extends LogOpportunity>(snapshot: Pick<LogsSnapshot, "groups" | "range" | "totals">, cuts: LogPlanCut<T>[]): LogServicePlan<T>[] {
  const plans = new Map<string | null, LogServicePlan<T>>()
  for (const cut of cuts) {
    const service = opportunityService(cut)
    let plan = plans.get(service)
    if (!plan) {
      const group = service === null ? undefined : snapshot.groups.find((item) => item.value === service)
      plan = { service, bytesPerDay: group ? perDay(group.bytes, snapshot.range) : 0, share: group?.share ?? 0, cuts: [], openSavings: 0, totalSavings: 0 }
      plans.set(service, plan)
    }
    plan.cuts.push(cut)
  }
  for (const plan of plans.values()) {
    // Stable order (cuts don't move when added): debug lines, then noisy patterns by saving, then labels.
    plan.cuts.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || (b.savedBytesPerDay ?? 0) - (a.savedBytesPerDay ?? 0) || a.title.localeCompare(b.title))
    plan.totalSavings = plan.cuts.reduce((sum, cut) => sum + (cut.savedBytesPerDay ?? 0), 0)
    plan.openSavings = plan.cuts.filter((cut) => cut.state !== "active").reduce((sum, cut) => sum + (cut.savedBytesPerDay ?? 0), 0)
  }
  return Array.from(plans.values()).sort(
    (a, b) => Number(a.service === null) - Number(b.service === null) || b.totalSavings - a.totalSavings || b.bytesPerDay - a.bytesPerDay
  )
}
