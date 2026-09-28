import * as React from "react"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { Combobox } from "@/components/combobox"
import { InfoTip } from "@/components/info-tip"
import { SegmentedControl } from "@/components/segmented-control"
import { Spinner } from "@/components/ui/spinner"
import { Term } from "@/features/rules/term"
import { summarizeRule, useUsageEvidence } from "@/features/rules/usage"
import { connectionKey, useConnection, useLabelValues, useMetricsTarget } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { mergeChoicesFor, type MetricsDestination } from "@/lib/core/backend-profile"
import { createLimiter } from "@/lib/core/concurrency"
import { histogramFamily } from "@/lib/core/families"
import { mergesSeries, type DropLabelsRule, type MergeChoice, type Rule } from "@/lib/core/rules"
import { fetchMergeGroups, fetchMetricType, measureImpact, type MetricType } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// A label drop that merges series is the user's call: drop it anyway, keep
// one value, or aggregate (where the destination can). This is the preview
// (series before → after, example groups that merge) and the choice.

const measure = createLimiter(2)

/** Series removed if `label` were dropped; shared by the labels table and the drop gate. */
export function useLabelDropImpact(metric: string, label: string, enabled: boolean, job?: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["label-drop-impact", connectionKey(connection), metric, label, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: ({ signal }) =>
      measure(() =>
        measureImpact(connection!, { kind: "drop_labels", selector: job === undefined ? { metric } : { metric, job }, labels: [label] }, signal)
      ),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useMetricType(metric: string) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["metric-type", connectionKey(connection), metric],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchMetricType(connection!, metric, signal),
    retry: false,
    staleTime: Infinity,
  }).data
}

function useMergeGroups(metric: string, labels: string[], job: string | undefined) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["merge-groups", connectionKey(connection), metric, labels, job ?? null],
    enabled: Boolean(connection) && labels.length > 0,
    queryFn: ({ signal }) => measure(() => fetchMergeGroups(connection!, { metric, job, labels }, { limit: 3, signal })),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/**
 * Which merging rules nothing is known to use (alert and recording rules,
 * scanned dashboards): those default to "drop anyway". By rule id.
 */
export function useUnusedMerges(rules: Rule[]) {
  const merging = React.useMemo(() => rules.filter(mergesSeries), [rules])
  const metrics = React.useMemo(() => merging.map((rule) => rule.selector.metric), [merging])
  const { byMetric, isPending } = useUsageEvidence(metrics, merging.length > 0)
  return React.useMemo(() => {
    const unused = new Set<string>()
    if (!isPending) {
      for (const rule of merging) {
        const summary = summarizeRule(rule, byMetric[rule.selector.metric])
        if (summary && !summary.used) unused.add(rule.id)
      }
    }
    return { unused, isPending }
  }, [merging, byMetric, isPending])
}

/** Rules with the unused-label default applied, for exports: an undecided unused drop becomes "drop anyway". */
export function withMergeDefaults(rules: Rule[], unused: Set<string>): Rule[] {
  return rules.map((rule) => (rule.kind === "drop_labels" && !rule.onMerge && unused.has(rule.id) ? { ...rule, onMerge: "drop" } : rule))
}

export const CHOICE_LABEL: Record<MergeChoice, string> = { drop: "Drop anyway", keep_value: "Keep one", aggregate: "Aggregate" }

/** What a choice does, in one line. */
function consequence(choice: MergeChoice, labels: string[], type: MetricType | undefined, destination: MetricsDestination) {
  const names = labels.join(", ")
  if (choice === "drop") return "Merged series keep one sample each scrape."
  if (choice === "keep_value") return `Only series with the kept ${names} stay; the rest are dropped whole.`
  const what = type === "gauge" ? "gauges" : "series"
  return destination === "grafana-cloud"
    ? `Adaptive Metrics sums the merged ${what}.`
    : `A recording rule ships the sum of the merged ${what}; the raw metric stays local.`
}

function WhyTip({ destination }: { destination: MetricsDestination }) {
  return (
    <InfoTip label="Why choose?" className="-my-1 ml-0.5">
      Dropping a label that tells series apart makes several series identical. A relabel drop keeps one sample per group and the
      backend rejects the rest as duplicates. Keeping one value avoids the merge; aggregating keeps the totals
      {destination === "grafana-cloud" ? " (Adaptive Metrics)" : destination === "remote-write" ? " (recording rule)" : ", but needs remote write or Grafana Cloud"}.
    </InfoTip>
  )
}

/** "86 → 11 series" and up to three groups that would become one. */
export function MergePreview({
  metric,
  job,
  labels,
  before,
  after,
  className,
}: {
  metric: string
  job?: string
  labels: string[]
  before: number
  after: number
  className?: string
}) {
  const { data, isPending } = useMergeGroups(metric, labels, job)
  // Labels every group shares (job, instance…) say nothing; show the ones that tell groups apart.
  const shown = React.useMemo(() => {
    if (!data || data.length < 2) return null
    const keys = new Set(data.flatMap((group) => Object.keys(group.labels)))
    const varying = [...keys].filter((key) => new Set(data.map((group) => group.labels[key] ?? "")).size > 1)
    return varying.length ? new Set(varying) : null
  }, [data])
  return (
    <div className={cn("flex flex-col gap-1.5 text-xs", className)}>
      <p className="font-medium tabular-nums">
        {formatNumber(before)} → {formatNumber(after)} series <span className="font-normal text-muted-foreground">without {labels.join(", ")}</span>
      </p>
      {isPending ? (
        <Spinner className="size-3" />
      ) : data?.length ? (
        <ul className="flex flex-col gap-1" aria-label="Series that would merge">
          {data.map((group) => {
            const text = Object.entries(group.labels)
              .filter(([key]) => !shown || shown.has(key))
              .map(([key, value]) => `${key}="${value}"`)
              .join(", ")
            return (
              <li key={text} className="flex min-w-0 items-center gap-2 rounded-md bg-well px-2 py-1">
                <span className="shrink-0 tabular-nums text-muted-foreground">{group.series} → 1</span>
                <span className="truncate font-mono text-[11px]" title={`{${text}}`}>
                  {`{${text}}`}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/** Picks the kept value per label, defaulting to each label's most common value. */
function KeepValuePicker({
  metric,
  job,
  label,
  value,
  onChange,
}: {
  metric: string
  job?: string
  label: string
  value: string | undefined
  onChange: (value: string) => void
}) {
  const { data } = useLabelValues(metric, label, true, job)
  const top = data?.find((item) => item.value !== "")?.value
  React.useEffect(() => {
    if (value === undefined && top !== undefined) onChange(top)
  }, [value, top, onChange])
  if (!data) return <Spinner className="size-3" />
  return (
    <Combobox
      aria-label={`Value of ${label} to keep`}
      prefix={`${label} =`}
      mono
      value={value ?? ""}
      onValueChange={onChange}
      options={data.filter((item) => item.value !== "").map((item) => ({ value: item.value, detail: formatNumber(item.seriesCount) }))}
      className="h-7 text-xs"
    />
  )
}

export interface MergeDecision {
  choice: MergeChoice | null
  keepValues?: Record<string, string>
}

/**
 * The choice itself: a segmented control (aggregate only where the
 * destination can), a one-line consequence, and value pickers for "keep one
 * value". Bucket-heavy histograms get "Trim buckets" instead of dropping le.
 */
export function MergeChoiceControl({
  metric,
  job,
  labels,
  decision,
  onChange,
  defaulted = false,
  className,
}: {
  metric: string
  job?: string
  labels: string[]
  decision: MergeDecision
  onChange: (decision: MergeDecision) => void
  /** The choice shown is the unused-label default, not one the user made. */
  defaulted?: boolean
  className?: string
}) {
  const { destination } = useMetricsTarget()
  const type = useMetricType(metric)
  const choices = mergeChoicesFor(destination)
  const trimBuckets = labels.includes("le") && histogramFamily(metric).part === "bucket"
  const { choice, keepValues } = decision
  const setKeep = React.useCallback(
    (label: string, value: string) => onChange({ choice: "keep_value", keepValues: { ...keepValues, [label]: value } }),
    [keepValues, onChange]
  )

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <SegmentedControl
          size="sm"
          aria-label={`When dropping ${labels.join(", ")} merges series`}
          value={(choice ?? "") as MergeChoice}
          onValueChange={(next) => onChange({ choice: next, keepValues: next === "keep_value" ? keepValues : undefined })}
          options={choices.map((value) => ({ value, label: CHOICE_LABEL[value] }))}
        />
        {trimBuckets ? (
          <Link to={`${metricPath(metric)}?label=le`} className="inline-flex items-center gap-0.5 text-xs text-brand-ink hover:underline">
            Trim buckets
            <ArrowRightIcon className="size-3" />
          </Link>
        ) : null}
      </div>
      {choice && !choices.includes(choice) ? (
        <p className="text-xs text-brand-ink">
          {CHOICE_LABEL[choice]} needs remote write or Grafana Cloud; pick another to export it here.
          <WhyTip destination={destination} />
        </p>
      ) : choice ? (
        <p className="text-xs text-muted-foreground">
          {consequence(choice, labels, type, destination)}
          {defaulted ? " Default: nothing uses it." : ""}
          <WhyTip destination={destination} />
        </p>
      ) : (
        <p className="text-xs text-brand-ink">
          <Term id="mergesSeries">Merges series</Term>; pick one to export it.
          <WhyTip destination={destination} />
        </p>
      )}
      {choice === "keep_value" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {labels.map((label) => (
            <KeepValuePicker key={label} metric={metric} job={job} label={label} value={keepValues?.[label]} onChange={(value) => setKeep(label, value)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The choice on an existing rule, stored on it. Nothing for rules that don't merge series. */
export function RuleMergeControl({ rule, unused, className }: { rule: Rule; unused?: boolean; className?: string }) {
  const setRuleMerge = useAppStore((state) => state.setRuleMerge)
  const onChange = React.useCallback(
    (decision: MergeDecision) => setRuleMerge(rule.id, decision.choice ?? undefined, decision.keepValues),
    [rule.id, setRuleMerge]
  )
  const labelRule: DropLabelsRule | null = rule.kind === "drop_labels" ? rule : null
  if (!labelRule || (!labelRule.impact?.mergesSeries && labelRule.onMerge !== "keep_value")) return null
  const choice = labelRule.onMerge ?? (unused ? "drop" : null)
  return (
    <MergeChoiceControl
      metric={rule.selector.metric}
      job={rule.selector.job}
      labels={labelRule.labels}
      decision={{ choice, keepValues: labelRule.keepValues }}
      onChange={onChange}
      defaulted={!labelRule.onMerge && choice !== null}
      className={className}
    />
  )
}
