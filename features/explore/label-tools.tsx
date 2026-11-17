import * as React from "react"
import { FingerprintIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"

import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { targetJob, type DropScope } from "@/features/explore/drop-scope"
import { GroupValuesForm } from "@/features/rules/group-values-form"
import { useLabelDropImpact } from "@/features/rules/merge-choice"
import { BucketPicker, SeriesPatternForm, valuesPattern } from "@/features/rules/series-rule-forms"
import { connectionKey, useConnection, useLabelValues } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { createLimiter } from "@/lib/core/concurrency"
import { histogramFamily } from "@/lib/core/families"
import { detectIdLike, generalizePath, ID_KIND_LABEL, type IdLikeVerdict } from "@/lib/core/id-like"
import { fullMatch } from "@/lib/core/regex"
import { fetchTopLabelValues } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

// What to do with one label of a metric, shared by the metric page and the
// job workbench: its measured saving, the ID check and its values (drop the
// series matching a pattern, or group the values).

// Label measurements (−series if dropped, top values for the ID check) start
// on hover or expand; at most two run at once so sweeping over the table
// doesn't flood the backend.
const measure = createLimiter(2)
const TOP_VALUES = 25

/** Top values of a label, shared with the expanded list (same cache key as useLabelValues). */
export function useTopValues(metric: string, label: string, enabled: boolean, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["label-values", connectionKey(connection), metric, label, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: ({ signal }) => measure(() => fetchTopLabelValues(connection!, metric, label, { job, limit: TOP_VALUES, signal })),
    staleTime: 5 * 60_000,
  })
}

export function DropImpactCell({ metric, label, job, requested }: { metric: string; label: string; job?: string; requested: boolean }) {
  const { data, isFetching, error } = useLabelDropImpact(metric, label, requested, job)
  if (!requested) return <span className="text-xs text-muted-foreground/60">hover</span>
  if (error) return <span className="text-xs text-muted-foreground" title={error.message}>n/a</span>
  if (!data) return isFetching ? <Spinner className="ml-auto size-3.5" /> : null
  const saved = data.seriesBefore - data.seriesAfter
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex flex-col items-end tabular-nums" tabIndex={0}>
          <span className="text-sm">{formatDelta(-saved)}</span>
          {data.mergesSeries ? <span className="text-[11px] text-brand-ink">merges series</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {data.mergesSeries
          ? `${formatNumber(data.seriesBefore)} → ${formatNumber(data.seriesAfter)} series without ${label}. Dropping it asks how to handle the merge.`
          : `Every series stays distinct without ${label}: it saves no series, only bytes.`}
      </TooltipContent>
    </Tooltip>
  )
}

export function IdBadge({ verdict }: { verdict: IdLikeVerdict }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0 border-brand/40 text-brand-ink" tabIndex={0}>
          <FingerprintIcon data-icon="inline-start" />
          looks like IDs
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {Math.round(verdict.share * 100)}% of the top values look like {ID_KIND_LABEL[verdict.kind]} (e.g. {verdict.examples[0]}). Labels like this
        grow without bound; drop the label, or drop the series matching a pattern.
      </TooltipContent>
    </Tooltip>
  )
}

export function LabelValues({
  metric,
  label,
  job,
  scope,
  seriesCount,
  initialMode,
}: {
  metric: string
  label: string
  job?: string
  scope: DropScope
  seriesCount: number
  /** Which tool opens first; else grouping when the label is grouped already, dropping series otherwise. */
  initialMode?: "drop" | "group"
}) {
  const { data, isPending, error } = useLabelValues(metric, label, true, job)
  const [pattern, setPattern] = React.useState("")
  const ruleJob = targetJob(job, scope)
  const rules = useAppStore((state) => state.rules)
  const grouped = rules.some(
    (rule) => rule.kind === "group_values" && rule.status === "active" && rule.selector.metric === metric && rule.label === label && rule.selector.job === ruleJob
  )
  const [mode, setMode] = React.useState<"drop" | "group">(initialMode ?? (grouped ? "group" : "drop"))

  if (label === "le" && histogramFamily(metric).part === "bucket") return <BucketPicker metric={metric} job={ruleJob} />
  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Spinner />
        Loading top values…
      </div>
    )
  }
  if (error) return <p className="py-2 text-xs text-destructive">{error.message}</p>

  const verdict = detectIdLike(data.map((item) => item.value))
  const suggestion = verdict?.kind === "path" ? generalizePath(verdict.examples[0]) : null
  const matches = (regex: string, value: string) => Boolean(regex) && fullMatch(regex, value)
  const picked = (value: string) => matches(pattern, value)
  const pick = (value: string) =>
    // Clicking toggles the value in a literal alternation of the picked values.
    setPattern((previous) => {
      const current = data.filter((item) => matches(previous, item.value)).map((item) => item.value)
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      return next.length ? valuesPattern(next) : ""
    })

  const modes = (
    <SegmentedControl
      size="sm"
      className="self-start"
      aria-label={`What to do with ${label} values`}
      value={mode}
      onValueChange={setMode}
      options={[
        { value: "drop", label: "Drop series", title: "Drop the series whose value matches a pattern" },
        { value: "group", label: "Group values", title: "Fold many values into a few and merge their series" },
      ]}
    />
  )
  if (mode === "group") {
    return (
      <div className="flex flex-col gap-3 py-2">
        {modes}
        <GroupValuesForm metric={metric} label={label} job={ruleJob} values={data} seriesCount={seriesCount} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      {modes}
      <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        {data.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={picked(item.value)}
            title="Add to the series pattern"
            onClick={() => pick(item.value)}
            className="flex min-w-0 items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-destructive/10 aria-pressed:text-destructive"
          >
            <span className="truncate font-mono">{item.value || <em className="text-muted-foreground">empty</em>}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatNumber(item.seriesCount)} · {((item.seriesCount / Math.max(1, seriesCount)) * 100).toFixed(1)}%
            </span>
          </button>
        ))}
      </div>
      <SeriesPatternForm
        metric={metric}
        label={label}
        job={ruleJob}
        values={data}
        seriesCount={seriesCount}
        pattern={pattern}
        setPattern={setPattern}
        suggestion={suggestion}
      />
    </div>
  )
}
