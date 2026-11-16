import * as React from "react"
import { RulerIcon, StackIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { scopeText } from "@/features/explore/drop-scope"
import { ValueGrouper, type GroupingDraft } from "@/features/rules/value-grouper"
import { useConnection } from "@/hooks/use-cardinality"
import { measureGroupingImpact } from "@/hooks/use-rule-impacts"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { createRule, ruleKey, sameGrouping, type GroupValuesRule, type RuleImpact } from "@/lib/core/rules"
import {
  GROUP_AGGREGATIONS,
  groupingProblem,
  groupingRecordName,
  isCounterLike,
  type GroupAggregation,
  type ValueCount,
} from "@/lib/core/value-groups"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const AGGREGATION_HINT: Record<GroupAggregation, string> = {
  sum: "Adds the merged series up: requests, bytes, errors. The right choice for counters.",
  count: "Counts how many series went into each group, e.g. instances or pods per group.",
  max: "Keeps the largest merged value: worst latency, deepest queue.",
  min: "Keeps the smallest merged value: free space, lowest headroom.",
  avg: "Averages the merged values: utilisation, ratios.",
}

/**
 * Groups a label's values and saves a `group_values` rule: the grouper, the
 * aggregation that combines merged series, an exact before/after count and
 * the save. Opens on the active rule's grouping when there is one.
 */
export function GroupValuesForm({
  metric,
  label,
  job,
  values,
  seriesCount,
}: {
  metric: string
  label: string
  /** The job the rule applies to; undefined is every job. */
  job?: string
  values: ValueCount[]
  seriesCount: number
}) {
  const rules = useAppStore((state) => state.rules)
  const removeRule = useAppStore((state) => state.removeRule)
  const addRules = useAppStore((state) => state.addRules)
  const connection = useConnection()
  const selector = job === undefined ? { metric } : { metric, job }
  const key = ruleKey({ kind: "group_values", selector, label })
  const existing = rules.find((rule): rule is GroupValuesRule => rule.kind === "group_values" && rule.status === "active" && ruleKey(rule) === key)

  const [draft, setDraft] = React.useState<GroupingDraft>(() => ({ groups: existing?.groups ?? [], rest: existing?.rest }))
  const [aggregation, setAggregation] = React.useState<GroupAggregation>(existing?.aggregation ?? "sum")
  const grouping = { label, groups: draft.groups, rest: draft.rest, aggregation }
  const problem = groupingProblem(draft)
  const counter = isCounterLike(metric)
  const unchanged = existing ? sameGrouping(existing, { ...existing, ...grouping }) : false
  const fingerprint = JSON.stringify([draft, aggregation])

  const measure = useMutation({
    mutationKey: ["group-impact", metric, label, job ?? null],
    // The fingerprint ties a result to the draft it measured; an edit makes it stale.
    mutationFn: (variables: { fingerprint: string }) =>
      variables && measureGroupingImpact(connection!, { selector, label, groups: draft.groups, rest: draft.rest }),
  })
  const measured: RuleImpact | undefined = measure.data && measure.variables?.fingerprint === fingerprint ? measure.data : undefined

  function save() {
    if (problem) return
    if (existing) removeRule(existing.id)
    addRules([createRule({ kind: "group_values", selector, ...grouping, origin: "user", impact: measured })])
    toast.success(existing ? "Grouping updated" : "Grouping added", {
      description: `${metric}: ${label} into ${draft.groups.length + (draft.rest ? 1 : 0)} values, merged with ${aggregation} (${scopeText(job)}).`,
    })
  }

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-4">
      <ValueGrouper label={label} values={values} seriesCount={seriesCount} value={draft} onChange={setDraft} />

      <div className="flex flex-col gap-1.5 border-t border-dashed border-well-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">Merge series with</span>
          <SegmentedControl
            size="sm"
            aria-label="How merged series are combined"
            value={aggregation}
            onValueChange={setAggregation}
            options={GROUP_AGGREGATIONS.map((value) => ({ value, label: <span className="font-mono">{value}</span> }))}
          />
        </div>
        <p className="text-xs text-muted-foreground">{AGGREGATION_HINT[aggregation]}</p>
        {counter && aggregation !== "sum" ? (
          <p className="flex items-center gap-1 text-xs text-brand-ink">
            <WarningIcon className="size-3.5 shrink-0" aria-hidden />
            {metric} looks like a counter: only sum keeps rate() meaningful.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-background/50 p-2.5 ring-1 ring-well-border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MeasureResult impact={measured} pending={measure.isPending} error={measure.error} />
          <div className="flex flex-wrap gap-1.5">
            {existing ? (
              <Button size="sm" variant="ghost" onClick={() => removeRule(existing.id)}>
                <TrashIcon data-icon="inline-start" />
                Remove
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!connection || Boolean(problem) || measure.isPending}
              onClick={() => measure.mutate({ fingerprint })}
            >
              <RulerIcon data-icon="inline-start" />
              Measure
            </Button>
            <Button size="sm" disabled={Boolean(problem) || unchanged} onClick={save}>
              <StackIcon data-icon="inline-start" />
              {existing ? "Update grouping" : "Group values"}
            </Button>
          </div>
        </div>
        <p className={cn("text-[11px]", problem && draft.groups.length ? "text-destructive" : "text-muted-foreground")}>
          {problem && draft.groups.length ? (
            `Can't save yet: ${problem}.`
          ) : (
            <>
              Ships on remote write as the recording rule{" "}
              <code className="font-mono text-foreground">{groupingRecordName(metric, { label, aggregation })}</code>, and the raw metric
              stops being sent. Plain relabelling can't merge series, so scrape-time exports leave it out.
            </>
          )}
          {existing ? (
            <Badge variant="outline" className="ml-2 align-middle">
              {unchanged ? "rule active" : "edited, not saved"}
            </Badge>
          ) : null}
        </p>
      </div>
    </div>
  )
}

function MeasureResult({ impact, pending, error }: { impact?: RuleImpact; pending: boolean; error: Error | null }) {
  if (pending) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Counting merged series…
      </span>
    )
  }
  if (error) return <span className="text-xs text-destructive">{error.message}</span>
  if (!impact) return <span className="text-xs text-muted-foreground">Measure for the exact series count after grouping.</span>
  const saved = impact.seriesBefore - impact.seriesAfter
  return (
    <span className="flex items-baseline gap-2 text-xs tabular-nums">
      <span>
        {formatNumber(impact.seriesBefore)} <span className="text-muted-foreground">→</span>{" "}
        <span className="font-medium">{formatNumber(impact.seriesAfter)}</span> series
      </span>
      <span className="font-medium text-brand-ink">{formatDelta(-saved)}</span>
    </span>
  )
}
