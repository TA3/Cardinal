import {
  ArrowRightIcon,
  CheckIcon,
  RobotIcon,
  SparkleIcon,
  TrashIcon,
  UploadSimpleIcon,
  UserIcon,
  XIcon,
} from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { CostText } from "@/components/cost-text"
import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Tip } from "@/components/tip"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AcceptAllButton } from "@/features/rules/accept-all"
import { Term } from "@/features/rules/term"
import { jobLabel } from "@/lib/core/jobs"
import { formatAgo } from "@/lib/core/report"
import type { Rule } from "@/lib/core/rules"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { useAppStore } from "@/lib/store/app-store"

export function isAdaptiveRecommendation(rule: Rule) {
  return rule.origin === "import" && rule.rationale?.startsWith("Adaptive Metrics recommendation")
}

export function RuleOriginBadge({ rule }: { rule: Rule }) {
  if (rule.origin === "agent") {
    return (
      <Badge variant="secondary">
        <RobotIcon data-icon="inline-start" />
        Agent
      </Badge>
    )
  }
  if (isAdaptiveRecommendation(rule)) {
    return (
      <Badge variant="secondary">
        <SparkleIcon data-icon="inline-start" />
        Adaptive
      </Badge>
    )
  }
  if (rule.origin === "import") {
    return (
      <Badge variant="outline">
        <UploadSimpleIcon data-icon="inline-start" />
        Imported
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <UserIcon data-icon="inline-start" />
      You
    </Badge>
  )
}

/** Every rule shows where it applies: all jobs, or one job ("(no job)" for series without one). */
export function RuleScopeBadge({ rule }: { rule: Rule }) {
  const job = rule.selector.job
  return (
    <Badge variant="ghost" className="text-muted-foreground">
      {job === undefined ? "all jobs" : `job ${jobLabel(job)}`}
    </Badge>
  )
}

export function DropScopeToggle({
  value,
  onChange,
  job,
}: {
  value: "job" | "all"
  onChange: (value: "job" | "all") => void
  /** The context's job, named in the tooltip. */
  job?: string
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="whitespace-nowrap text-muted-foreground">Drop for</span>
      <SegmentedControl
        size="sm"
        aria-label="Scope of new drop rules"
        value={value}
        onValueChange={onChange}
        options={[
          {
            value: "job",
            label: "This job",
            title: job === undefined ? "Only the job the metric belongs to" : `Only job ${jobLabel(job)}`,
          },
          {
            value: "all",
            label: "All jobs",
            title: "Every job that emits the metric",
          },
        ]}
      />
    </div>
  )
}

function RuleKindBadges({ rule }: { rule: Rule }) {
  switch (rule.kind) {
    case "drop_metric":
      return <Badge variant="destructive">Drop metric</Badge>
    case "drop_labels":
      return rule.labels.map((label) => (
        <Badge key={label} variant="outline" className="font-mono">
          −{label}
        </Badge>
      ))
    case "drop_series":
      return (
        <Badge
          variant="outline"
          className="max-w-full font-mono"
          title={`Drops series where ${rule.match.label} matches ${rule.match.regex}`}
        >
          <span className="truncate">
            −{"{"}
            {rule.match.label}=~"{rule.match.regex}"{"}"}
          </span>
        </Badge>
      )
    case "keep_buckets":
      return (
        <Badge variant="outline" className="max-w-full font-mono" title={`Keeps le buckets ${rule.buckets.join(", ")}`}>
          <span className="truncate">keep le {rule.buckets.join(", ")}</span>
        </Badge>
      )
  }
}

export function RuleDescription({
  rule,
  hideMetric = false,
  supersededBy,
}: {
  rule: Rule
  hideMetric?: boolean
  /** The broader rule that makes this one redundant, if any. */
  supersededBy?: Rule
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {hideMetric ? null : <span className="truncate font-mono text-sm">{rule.selector.metric}</span>}
      <div className="flex flex-wrap items-center gap-1">
        <RuleKindBadges rule={rule} />
        <RuleScopeBadge rule={rule} />
        {supersededBy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" tabIndex={0}>
                superseded
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {supersededBy.kind === "drop_metric"
                ? `The metric is already dropped for ${supersededBy.selector.job === undefined ? "all jobs" : `job ${jobLabel(supersededBy.selector.job)}`}, so this rule changes nothing. It isn't exported or counted.`
                : "A rule for all jobs already drops these labels, so this one changes nothing. It isn't exported or counted."}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Plain-words explanation for a label drop that merges series, with the
 * relabel-safe alternatives: drop the series matching a value pattern, or
 * (for `le`) keep only some buckets. Nothing for other rules.
 */
export function MergeNote({ rule, className }: { rule: Rule; className?: string }) {
  if (rule.kind !== "drop_labels" || !rule.impact?.mergesSeries) return null
  const { seriesBefore, seriesAfter } = rule.impact
  // A value pattern only makes sense on a label other than le.
  const patternLabel = rule.labels.find((label) => label !== "le")
  const link = (label: string) => `${metricPath(rule.selector.metric)}?label=${encodeURIComponent(label)}`
  return (
    <div className={className}>
      <p className="text-xs text-pretty">
        Collapses {formatNumber(seriesBefore)} series into {formatNumber(seriesAfter)}. That needs{" "}
        <Term id="relabelVsAggregation">aggregation</Term> (<Term id="adaptiveMetrics">Adaptive Metrics</Term>); relabelling would
        create duplicate samples.
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Or, relabel-safe:</span>
        {patternLabel ? (
          <Link to={link(patternLabel)} className="inline-flex items-center gap-0.5 text-brand-ink hover:underline">
            Drop series matching a value pattern
            <ArrowRightIcon className="size-3" />
          </Link>
        ) : null}
        {rule.labels.includes("le") ? (
          <Link to={link("le")} className="inline-flex items-center gap-0.5 text-brand-ink hover:underline">
            Keep only selected le buckets
            <ArrowRightIcon className="size-3" />
          </Link>
        ) : null}
      </p>
    </div>
  )
}

export function RuleImpact({ rule, totalSeries, showCost = true }: { rule: Rule; totalSeries: number; showCost?: boolean }) {
  if (!rule.impact) return <span className="text-xs text-muted-foreground">Not measured</span>
  const saved = rule.impact.seriesBefore - rule.impact.seriesAfter
  const ago = formatAgo(rule.impact.measuredAt)
  return (
    <div className="flex flex-col items-end">
      <span className="text-sm tabular-nums">{formatDelta(-saved)}</span>
      {totalSeries > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">{((saved / totalSeries) * 100).toFixed(2)}%</span>
      ) : null}
      {showCost ? <CostText series={saved} /> : null}
      {rule.impact.mergesSeries ? <span className="text-xs text-destructive">merges series</span> : null}
      {ago ? (
        <span className="text-[11px] text-muted-foreground/80" title={new Date(rule.impact.measuredAt).toLocaleString()}>
          {rule.kind === "drop_metric" ? "snapshot" : "measured"} {ago}
        </span>
      ) : null}
    </div>
  )
}

export function RuleActions({ rule }: { rule: Rule }) {
  const setRuleStatus = useAppStore((state) => state.setRuleStatus)
  const removeRule = useAppStore((state) => state.removeRule)
  if (rule.status === "proposed") {
    return (
      <div className="flex justify-end gap-1">
        <Tip label="Reject proposal">
          <Button size="icon-sm" variant="ghost" aria-label="Reject" onClick={() => setRuleStatus([rule.id], "rejected")}>
            <XIcon />
          </Button>
        </Tip>
        <AcceptAllButton
          rules={[rule]}
          onAccept={(ids) => setRuleStatus(ids, "active")}
          trigger={
            <Button size="icon-sm" variant="outline" aria-label="Accept">
              <CheckIcon />
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className="flex justify-end gap-1">
      {rule.status === "rejected" ? (
        <Button size="xs" variant="ghost" onClick={() => setRuleStatus([rule.id], "proposed")}>
          Restore
        </Button>
      ) : null}
      <Tip label="Remove rule">
        <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => removeRule(rule.id)}>
          <TrashIcon />
        </Button>
      </Tip>
    </div>
  )
}
