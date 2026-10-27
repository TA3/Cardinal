import type { Preference } from "@/lib/core/decide/learn"
import type { LogOpportunity, MetricOpportunity } from "@/lib/core/opportunities"
import { summarizeEvidence, type UsageEvidence } from "@/lib/core/usage-gate"

// How safe a cut is, in one word, with how sure Cardinal is and why. The
// static rules find the cuts; this ranks what to trust. It never overrides a
// guard: guarded labels are filtered out before an opportunity exists.
//
// Confidence is how much of the usage picture was actually checked (rules,
// dashboards, Grafana Cloud usage) and whether the saving was measured. It
// is a plain score, not a calibrated probability. learn.ts then shifts the
// level by what this user accepted and rejected before.

export type RiskLevel = "safe" | "review" | "risky"

export const RISK_LABEL: Record<RiskLevel, string> = {
  safe: "Safe",
  review: "Review",
  risky: "Risky",
}

export const RISK_ORDER: RiskLevel[] = ["safe", "review", "risky"]

export interface Assessment {
  level: RiskLevel
  /** 0..1: how much of the evidence this verdict rests on was checked. */
  confidence: number
  /** Short plain-language reasons, most important first. */
  why: string[]
  /** The evidence that, once gathered, could change the verdict. */
  missing?: "usage" | "dashboards"
  /** The user's track record on cuts like this, when there is one (see learn.ts). */
  learned?: Preference
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** What was checked for a metric: Prometheus rules, a Grafana scan, Grafana Cloud usage. */
function coverage(evidence: UsageEvidence | undefined) {
  const rules = Boolean(evidence && evidence.rules !== null)
  // An upload of rule files alone holds no dashboards: that checked nothing about dashboards.
  const dashboards = Boolean(evidence?.dashboards?.dashboardsScanned)
  const cloud = Boolean(evidence?.cloudUsage)
  return {
    rules,
    dashboards,
    cloud,
    share: (rules ? 0.4 : 0) + (dashboards ? 0.35 : 0) + (cloud ? 0.35 : 0),
  }
}

/**
 * Risk of a metric opportunity given the usage evidence for its metric.
 * Unused and fully checked is safe; used (or a label in use) is risky; gaps
 * in what was checked, estimates and lossy cuts (buckets, churn) need review.
 */
export function assessMetric(
  item: Pick<MetricOpportunity, "reason" | "label" | "estimate" | "rule">,
  evidence: UsageEvidence | undefined
): Assessment {
  const seen = coverage(evidence)
  const summary = evidence ? summarizeEvidence(evidence, item.label) : null
  const why: string[] = []
  let level: RiskLevel
  let missing: Assessment["missing"]

  if (!summary || seen.share === 0) {
    missing = "usage"
    level = "review"
    why.push("Usage couldn't be checked")
  } else if (summary.used) {
    level = "risky"
    why.push(item.label ? `Something may use ${item.label}` : "Rules or dashboards use it")
  } else if (!seen.dashboards && !seen.cloud) {
    level = "review"
    missing = "dashboards"
    why.push("Not in alert or recording rules; dashboards not checked")
  } else if (!seen.rules && !seen.cloud) {
    // Uploaded dashboards with a pasted snapshot, or a rules API that failed: an alert could still read it.
    level = "review"
    missing = "usage"
    why.push("Not on any checked dashboard; alert and recording rules not checked")
  } else {
    level = "safe"
    why.push(item.label ? `Nothing groups or filters by ${item.label}` : "No rule, dashboard or query uses it")
  }

  if (item.reason === "buckets" && level === "safe") {
    // Fewer buckets keeps the metric but coarsens quantiles.
    level = "review"
    why.push("Quantiles get coarser")
  }
  if (item.reason === "churn" && level === "safe") {
    level = "review"
    why.push("Churn driver from the last hour only")
  }
  if (item.rule.kind === "drop_labels" && item.rule.onMerge === undefined && summary?.used) {
    why.push("Merged series need a choice")
  }
  if (item.estimate) why.push("Saving is an estimate")

  const confidence = clamp(seen.share * (item.estimate ? 0.8 : 1))
  return { level, confidence, why, ...(missing ? { missing } : {}) }
}

/** Log lines that are usually worth keeping whatever their volume. */
const KEEP_WORDS =
  /\b(audit|security|auth[a-z]*|login|logout|permission|denied|forbidden|payment|billing|invoice|transaction|refund|charge|compliance|gdpr|consent)\b/i

/**
 * Risk of a log opportunity. Debug and trace lines are safe to drop; sampling
 * loses lines, so it needs review; lines that look like audit, security or
 * money trails are risky to touch. Moving a label to structured metadata is
 * reversible and keeps it searchable, but changes how queries select it.
 *
 * The keyword check is the hook for a text model: it answers "is this line
 * something people must keep?", which a classifier can answer better.
 */
export function assessLog(
  item: Pick<LogOpportunity, "reason" | "title" | "subtitle" | "estimate">,
  { labelQueried }: { labelQueried?: boolean } = {}
): Assessment {
  const why: string[] = []
  let level: RiskLevel
  let confidence: number
  const text = `${item.title} ${item.subtitle ?? ""}`
  const sensitive = item.reason !== "labels" && KEEP_WORDS.test(text)

  if (item.reason === "debug") {
    level = "safe"
    confidence = 0.75
    why.push("Debug and trace lines only")
  } else if (item.reason === "noisy") {
    level = "review"
    confidence = 0.6
    why.push("Keeps 10% of a repeated line")
  } else if (labelQueried) {
    level = "risky"
    confidence = 0.8
    why.push(`Queries select streams by ${item.title}`)
  } else {
    level = labelQueried === false ? "safe" : "review"
    confidence = labelQueried === false ? 0.8 : 0.5
    why.push(labelQueried === false ? "No checked query selects by it" : "Stays searchable as metadata; queries weren't checked")
  }

  if (sensitive) {
    level = "risky"
    why.unshift("Looks like an audit, security or billing trail")
  }
  if (item.estimate) confidence *= 0.9
  return { level, confidence: clamp(confidence), why }
}

/**
 * The order cuts are shown in: open before already proposed, then safe
 * before review before risky; otherwise the incoming order (largest saving
 * first) holds.
 */
export function orderForReview<T extends { risk: Assessment; state: string }>(items: T[]) {
  return [...items].sort(
    (a, b) => Number(a.state === "proposed") - Number(b.state === "proposed") || RISK_ORDER.indexOf(a.risk.level) - RISK_ORDER.indexOf(b.risk.level)
  )
}

/** Safe first, then by confidence (highest first). */
export function compareAssessments(a: Assessment, b: Assessment) {
  return RISK_ORDER.indexOf(a.level) - RISK_ORDER.indexOf(b.level) || b.confidence - a.confidence
}
