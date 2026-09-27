import * as React from "react"
import { CheckIcon, FunnelIcon, LockSimpleIcon, TrashIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { scopeText } from "@/features/explore/drop-scope"
import { Term } from "@/features/rules/term"
import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { fullMatch, literalAlternation, regexProblem } from "@/lib/core/regex"
import { createRule, INF_BUCKET, normalizeBuckets, ruleKey, type KeepBucketsRule } from "@/lib/core/rules"
import { fetchTopLabelValues, type LabelValueCount } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// Relabel-safe alternatives to a label drop that merges series: drop only the
// series whose label matches a value pattern, or keep only some histogram
// buckets. Both drop whole series, so relabelling them never collides.

/** Rule for `selector` of `kind`, active; replaces an active rule with the same key. */
function saveRule(rule: ReturnType<typeof createRule>) {
  const { rules, removeRule, addRules } = useAppStore.getState()
  const existing = rules.find((item) => item.status === "active" && ruleKey(item) === ruleKey(rule))
  if (existing) removeRule(existing.id)
  addRules([rule])
}

/**
 * Pattern form under a label's top values: pick values (or type a regex) and
 * add a `drop_series` rule. `pattern`/`setPattern` are owned by the caller so
 * clicking values in the list can fill it.
 */
export function SeriesPatternForm({
  metric,
  label,
  job,
  values,
  seriesCount,
  pattern,
  setPattern,
  suggestion,
}: {
  metric: string
  label: string
  /** The job the new rule applies to; undefined is every job. */
  job?: string
  values: LabelValueCount[]
  seriesCount: number
  pattern: string
  setPattern: React.Dispatch<React.SetStateAction<string>>
  /** A generalised pattern for ID-like values, offered as a one-click fill. */
  suggestion?: string | null
}) {
  const problem = pattern ? regexProblem(pattern) : null
  const matched = React.useMemo(
    () => (pattern && !problem ? values.filter((item) => fullMatch(pattern, item.value)) : []),
    [pattern, problem, values]
  )
  const matchedSeries = matched.reduce((sum, item) => sum + item.seriesCount, 0)
  const all = matched.length === values.length && values.length > 0
  const inputId = React.useId()

  function add() {
    if (!pattern || problem) return
    saveRule(createRule({ kind: "drop_series", selector: job === undefined ? { metric } : { metric, job }, match: { label, regex: pattern }, origin: "user" }))
    toast.success("Series drop added", { description: `${metric}: series where ${label} matches ${pattern} (${scopeText(job)}).` })
    setPattern("")
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-dashed border-well-border bg-background/40 p-2.5">
      <label htmlFor={inputId} className="flex items-center gap-1.5 text-xs font-medium">
        <FunnelIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Drop the series where <code className="font-mono">{label}</code> matches
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="Pick values above or type a regex, e.g. /api/users/.+"
          spellCheck={false}
          aria-invalid={Boolean(problem)}
          className="h-8 min-w-48 flex-1 font-mono text-xs"
        />
        <Button size="sm" variant="destructive" disabled={!pattern || Boolean(problem)} onClick={add}>
          Drop matching series
        </Button>
      </div>
      {suggestion && suggestion !== pattern ? (
        <button
          type="button"
          onClick={() => setPattern(suggestion)}
          className="self-start rounded-full text-left text-xs text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Use the ID pattern <code className="font-mono">{suggestion}</code>
        </button>
      ) : null}
      <p className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
        {problem
          ? `Not a usable regex: ${problem}.`
          : pattern
            ? `Matches ${matched.length} of the top ${values.length} values: at least ${formatNumber(matchedSeries)} of ${formatNumber(seriesCount)} series. The exact count is measured once the rule is added.${all ? " That is every value shown; consider dropping the metric instead." : ""}`
            : "Drops whole series, so relabelling can't create duplicates. Anchored: the pattern must match the whole value."}
      </p>
    </div>
  )
}

function useAllBuckets(metric: string, job: string | undefined) {
  const connection = useConnection()
  return useQuery({
    queryKey: ["le-buckets", connectionKey(connection), metric, job ?? null],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchTopLabelValues(connection!, metric, "le", { job, limit: 200, signal }),
    staleTime: 5 * 60_000,
  })
}

/** Picks the `le` buckets to keep for a `_bucket` metric and saves a `keep_buckets` rule. */
export function BucketPicker({ metric, job }: { metric: string; job?: string }) {
  const { data, isPending, error } = useAllBuckets(metric, job)
  const rules = useAppStore((state) => state.rules)
  const removeRule = useAppStore((state) => state.removeRule)
  const key = ruleKey({ kind: "keep_buckets", selector: job === undefined ? { metric } : { metric, job } })
  const existing = rules.find((rule): rule is KeepBucketsRule => rule.kind === "keep_buckets" && rule.status === "active" && ruleKey(rule) === key)

  const buckets = React.useMemo(() => {
    const counts = new Map((data ?? []).map((item) => [item.value, item.seriesCount]))
    return normalizeBuckets(counts.keys()).map((value) => ({ value, seriesCount: counts.get(value) ?? 0 }))
  }, [data])
  const [kept, setKept] = React.useState<Set<string> | null>(null)
  const current = kept ?? new Set(existing?.buckets ?? buckets.map((bucket) => bucket.value))

  if (isPending) return <Skeleton className="h-16" />
  if (error) return <p className="py-2 text-xs text-destructive">{error.message}</p>

  const dropped = buckets.filter((bucket) => !current.has(bucket.value))
  const droppedSeries = dropped.reduce((sum, bucket) => sum + bucket.seriesCount, 0)
  const initial = () => new Set(existing?.buckets ?? buckets.map((bucket) => bucket.value))
  const toggle = (value: string) => {
    if (value === INF_BUCKET) return
    setKept((previous) => {
      const next = new Set(previous ?? initial())
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function save() {
    saveRule(createRule({ kind: "keep_buckets", selector: job === undefined ? { metric } : { metric, job }, buckets: Array.from(current), origin: "user" }))
    toast.success("Bucket rule saved", { description: `${metric}: keeps ${current.size} of ${buckets.length} buckets (${scopeText(job)}).` })
    setKept(null)
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-xs text-muted-foreground">
        Each <Term id="histogramBuckets">bucket</Term> is its own series. Keep the ones your queries and SLOs use; +Inf always stays
        so histogram_quantile keeps working. Unselected buckets are dropped with a relabel rule, which never merges series.
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Buckets to keep">
        {buckets.map((bucket) => {
          const on = current.has(bucket.value)
          const locked = bucket.value === INF_BUCKET
          return (
            <button
              key={bucket.value}
              type="button"
              aria-pressed={on}
              disabled={locked}
              title={`${formatNumber(bucket.seriesCount)} series`}
              onClick={() => toggle(bucket.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                on
                  ? "border-foreground/20 bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground line-through decoration-destructive/60 hover:text-foreground",
                locked && "cursor-not-allowed opacity-80"
              )}
            >
              {locked ? <LockSimpleIcon className="size-3" aria-hidden /> : on ? <CheckIcon className="size-3" aria-hidden /> : null}
              {bucket.value}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          Keeps {current.size} of {buckets.length} buckets
          {dropped.length ? ` · ${formatDelta(-droppedSeries)} series` : ""}
          {existing ? (
            <Badge variant="outline" className="ml-2">
              rule active: keeps {existing.buckets.length}
            </Badge>
          ) : null}
        </span>
        <div className="flex gap-1.5">
          {existing ? (
            <Button size="sm" variant="ghost" onClick={() => removeRule(existing.id)}>
              <TrashIcon data-icon="inline-start" />
              Remove rule
            </Button>
          ) : null}
          <Button size="sm" disabled={!dropped.length || (existing && existing.buckets.join() === normalizeBuckets(current).join())} onClick={save}>
            {existing ? "Update bucket rule" : "Keep only these buckets"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The literal alternation for picked values, e.g. `a|b\.c`. */
export function valuesPattern(values: string[]) {
  return literalAlternation(values)
}
