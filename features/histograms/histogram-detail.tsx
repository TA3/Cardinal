import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  ClipboardTextIcon,
  LockSimpleIcon,
  PlusIcon,
} from "@phosphor-icons/react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { rulesPath } from "@/app/paths"
import { useCopy } from "@/components/code-block"
import { CostText } from "@/components/cost-text"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BucketChart } from "@/features/histograms/bucket-chart"
import {
  useBucketDistribution,
  useQuantileUsage,
} from "@/features/histograms/use-histograms"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import {
  bucketReductionSavings,
  formatBound,
  formatLe,
  formatQuantile,
  histogramUnit,
  nativeMigrationNotes,
  nativeSavings,
  precisionImpact,
  suggestBuckets,
  widestBand,
  type ClassicHistogram,
  type HistogramUnit,
  type KeepReason,
  type PrecisionRow,
} from "@/lib/core/histograms"
import {
  createRule,
  INF_BUCKET,
  normalizeBuckets,
  ruleKey,
} from "@/lib/core/rules"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const REASON_TEXT: Record<KeepReason, string> = {
  inf: "Always kept: histogram_quantile needs +Inf",
  used: "A rule reads this bucket directly",
  quantile: "Bounds a quantile your rules query",
  distribution: "Picked from where observations fall",
}

function BucketChips({
  les,
  kept,
  reasons,
  unit,
  onToggle,
}: {
  les: string[]
  kept: Set<string>
  reasons: Record<string, KeepReason>
  unit: HistogramUnit
  onToggle: (le: string) => void
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="group"
      aria-label="Buckets to keep"
    >
      {les.map((le) => {
        const on = kept.has(le)
        const locked = le === INF_BUCKET
        const reason = on ? reasons[le] : undefined
        const shown = formatLe(le, unit)
        return (
          <button
            key={le}
            type="button"
            aria-pressed={on}
            disabled={locked}
            title={`le="${le}"${reason ? ` · ${REASON_TEXT[reason]}` : on ? " · added by you" : " · dropped"}`}
            onClick={() => onToggle(le)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              on
                ? "border-foreground/20 bg-foreground text-background"
                : "border-border bg-background text-muted-foreground line-through decoration-destructive/60 hover:text-foreground",
              locked && "cursor-not-allowed opacity-80"
            )}
          >
            {locked ? (
              <LockSimpleIcon className="size-3" aria-hidden />
            ) : on ? (
              <CheckIcon className="size-3" aria-hidden />
            ) : null}
            {shown}
            {reason === "used" || reason === "quantile" ? (
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function bandText(lower: number, upper: number, unit: HistogramUnit) {
  return `${formatBound(lower, unit)} – ${formatBound(upper, unit)}`
}

function PrecisionTable({
  rows,
  unit,
}: {
  rows: PrecisionRow[]
  unit: HistogramUnit
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr_1fr]">
      <span className="hidden text-muted-foreground sm:inline">Quantile</span>
      <span className="hidden text-muted-foreground sm:inline">
        Now: true value lies in
      </span>
      <span className="hidden text-muted-foreground sm:inline">
        After: lies in
      </span>
      {rows.map((row) => {
        const worse = row.widening > 1.001
        return (
          <React.Fragment key={row.q}>
            <span className="font-medium tabular-nums">
              {formatQuantile(row.q)}
            </span>
            <span className="font-mono tabular-nums">
              <span className="font-sans text-muted-foreground sm:hidden">
                Now{" "}
              </span>
              {bandText(row.before.lower, row.before.upper, unit)}
              <span className="text-muted-foreground">
                {" "}
                ≈ {formatBound(row.before.value, unit)}
              </span>
            </span>
            <span
              className={cn(
                "font-mono tabular-nums",
                worse ? "text-brand-ink" : "text-muted-foreground",
                "col-start-2 sm:col-start-auto"
              )}
            >
              <span className="font-sans text-muted-foreground sm:hidden">
                After{" "}
              </span>
              {bandText(row.after.lower, row.after.upper, unit)}
              <span className="text-muted-foreground">
                {" "}
                ≈ {formatBound(row.after.value, unit)}
              </span>
              {worse ? (
                <span className="ml-1 font-sans">
                  (
                  {Number.isFinite(row.widening)
                    ? `${row.widening.toFixed(row.widening < 10 ? 1 : 0)}× wider`
                    : "unbounded"}
                  )
                </span>
              ) : (
                <span className="ml-1 font-sans">(unchanged)</span>
              )}
            </span>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function Estimate({
  label,
  saved,
  before,
  hint,
}: {
  label: React.ReactNode
  saved: number
  before: number
  hint: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-2xl border border-well-border bg-background/50 px-3 py-2 [corner-shape:squircle]">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-lg font-medium tabular-nums">
          ≈ {formatDelta(-saved)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {before
            ? `${((saved / before) * 100).toFixed(0)}% of ${formatNumber(before)}`
            : ""}
        </span>
      </span>
      <CostText series={saved} suffix="saved" />
      <span className="text-xs text-pretty text-muted-foreground">{hint}</span>
    </div>
  )
}

/**
 * One family's bucket tooling: distribution chart, editable kept `le` set,
 * precision impact, both savings estimates, and the two actions. `compact`
 * is the metric-page panel.
 */
export function HistogramDetail({
  family,
  job,
  jobs = [],
  compact = false,
}: {
  family: ClassicHistogram
  /** Scope for the proposed rule and the distribution; undefined is every job. */
  job?: string
  jobs?: string[]
  compact?: boolean
}) {
  const navigate = useNavigate()
  const unit = histogramUnit(family.base)
  const distribution = useBucketDistribution(family.bucketMetric, job)
  const usage = useQuantileUsage(family.bucketMetric)
  const points = React.useMemo(
    () => distribution.data?.points ?? [],
    [distribution.data]
  )
  const suggestion = React.useMemo(
    () =>
      suggestBuckets(family.les, points, {
        quantiles: usage.quantiles,
        pinned: usage.les,
      }),
    [family.les, points, usage]
  )
  const [edited, setEdited] = React.useState<Set<string> | null>(null)
  const kept = React.useMemo(
    () => edited ?? new Set(suggestion.kept),
    [edited, suggestion]
  )
  const keptList = React.useMemo(
    () =>
      normalizeBuckets(kept).filter(
        (le) => family.les.includes(le) || le === INF_BUCKET
      ),
    [kept, family.les]
  )
  const quantiles = usage.quantiles.length ? usage.quantiles : undefined
  const precision = React.useMemo(
    () => (points.length ? precisionImpact(points, keptList, quantiles) : null),
    [points, keptList, quantiles]
  )
  const band = React.useMemo(
    () => (points.length ? widestBand(points, keptList) : null),
    [points, keptList]
  )
  const reduction = bucketReductionSavings(family, keptList)
  const native = nativeSavings(family)
  const { copied, copy } = useCopy()
  const rules = useAppStore((state) => state.rules)
  const selector =
    job === undefined
      ? { metric: family.bucketMetric }
      : { metric: family.bucketMetric, job }
  const pending = rules.find(
    (rule) =>
      rule.kind === "keep_buckets" &&
      rule.status !== "rejected" &&
      ruleKey(rule) === ruleKey({ kind: "keep_buckets", selector })
  )

  const toggle = (le: string) => {
    if (le === INF_BUCKET) return
    setEdited((previous) => {
      const next = new Set(previous ?? suggestion.kept)
      if (next.has(le)) next.delete(le)
      else next.add(le)
      return next
    })
  }

  function propose() {
    const quantileText = usage.quantiles.length
      ? ` Rules query ${usage.quantiles.map(formatQuantile).join(", ")}.`
      : ""
    const precisionText = precision?.length
      ? ` ${precision.map((row) => `${formatQuantile(row.q)} ${row.widening > 1.001 ? `band ${Number.isFinite(row.widening) ? `${row.widening.toFixed(1)}×` : "unbounded"} wider` : "unchanged"}`).join(", ")}.`
      : ""
    const rule = createRule({
      kind: "keep_buckets",
      selector,
      buckets: keptList,
      origin: "user",
      status: "proposed",
      rationale: `Keeps ${keptList.length} of ${family.les.length} buckets of ${family.base} (≈ ${formatNumber(reduction.saved)} series, an estimate).${quantileText}${precisionText}`,
    })
    const { added, skipped } = useAppStore.getState().addRules([rule])
    if (!added) {
      toast.info("Already proposed", {
        description: skipped
          ? "A rule keeping these buckets (or fewer) already exists."
          : undefined,
      })
      return
    }
    toast.success("Bucket rule proposed", {
      description: `${family.bucketMetric}: keeps ${keptList.length} of ${family.les.length} buckets. Review it in Rules.`,
      action: {
        label: "Review",
        onClick: () => navigate(rulesPath("proposed")),
      },
    })
  }

  function copyNotes() {
    copy(nativeMigrationNotes(family, jobs))
    toast.success("Migration notes copied", {
      description:
        "Markdown for the service owner, with client and Prometheus settings.",
    })
  }

  const dropped = family.les.length - keptList.length
  const topKept = keptList.filter((le) => le !== INF_BUCKET).at(-1)
  const loading = distribution.isPending

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", compact ? "" : "py-2")}>
      {loading ? (
        <Skeleton className="h-[120px]" />
      ) : (
        <BucketChart
          les={family.les}
          points={points}
          kept={kept}
          unit={unit}
          onToggle={toggle}
          height={compact ? 72 : 96}
        />
      )}
      {distribution.error ? (
        <p className="text-xs text-destructive">
          Couldn't load the distribution: {distribution.error.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            Suggested <code className="font-mono text-xs">le</code> set
            <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
              keeps {keptList.length} of {family.les.length}
              {dropped > 0 ? ` · drops ${dropped}` : ""}
            </span>
          </span>
          {edited ? (
            <Button size="xs" variant="ghost" onClick={() => setEdited(null)}>
              <ArrowCounterClockwiseIcon data-icon="inline-start" />
              Reset to suggestion
            </Button>
          ) : null}
        </div>
        <BucketChips
          les={family.les}
          kept={kept}
          reasons={suggestion.reasons}
          unit={unit}
          onToggle={toggle}
        />
        <p className="text-xs text-pretty text-muted-foreground">
          {loading
            ? "Loading the bucket distribution…"
            : suggestion.fromDistribution
              ? `Weighted by ${distribution.data?.source === "lifetime" ? "lifetime counts (no observations in the last hour)" : "the last hour of observations"}: empty ranges merge first, busy buckets keep their resolution.`
              : "No observations yet, so the suggestion keeps roughly log-spaced buckets."}
          {usage.quantiles.length
            ? ` Rules query ${usage.quantiles.map(formatQuantile).join(", ")}; the buckets around them stay.`
            : ""}
          {usage.les.length
            ? ` Rules read le=${usage.les.map((le) => `"${le}"`).join(", ")} directly; those stay.`
            : ""}
        </p>
      </div>

      {precision ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Precision impact</span>
          <PrecisionTable rows={precision} unit={unit} />
          {band ? (
            <p className="text-xs text-muted-foreground">
              Widest remaining band with observations:{" "}
              {bandText(band.lower, band.upper, unit)} (
              {(band.upper / band.lower).toFixed(
                band.upper / band.lower < 10 ? 1 : 0
              )}
              ×, {(band.share * 100).toFixed(band.share < 0.1 ? 1 : 0)}% of
              observations). histogram_quantile interpolates linearly inside a
              bucket, so a quantile there can land anywhere in it.
              {topKept
                ? ` Anything above ${formatLe(topKept, unit)} reports as ${formatLe(topKept, unit)}.`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          "flex gap-2",
          compact ? "flex-col sm:flex-row" : "flex-col md:flex-row"
        )}
      >
        <Estimate
          label="Bucket reduction (estimate)"
          saved={reduction.saved}
          before={family.bucketSeries}
          hint={`Drops ${dropped} bucket series per label set. A relabel rule, so no client change.`}
        />
        <Estimate
          label={
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px]"
                >
                  Native histogram (estimate)
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-72 text-pretty">
                About one series per label set instead of le count + 2. Needs
                Prometheus 2.40+ with native histograms enabled (or OTLP
                exponential histograms), client library support and protobuf
                scraping. Queries change to histogram_quantile on the native
                series. Grafana Cloud may bill native histograms differently
                from float series, so check before counting on this.
              </TooltipContent>
            </Tooltip>
          }
          saved={native.saved}
          before={family.familySeries}
          hint={
            family.alsoNative
              ? "Already scraped as native too: turning off classic scraping realises this."
              : `${formatNumber(family.labelSets)} label sets × (${family.les.length} + 2) → ~${formatNumber(native.seriesAfter)}. Needs client and query changes.`
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={dropped <= 0 || Boolean(pending)}
          onClick={propose}
        >
          <PlusIcon data-icon="inline-start" />
          Propose keep_buckets rule
        </Button>
        <Button size="sm" variant="outline" onClick={copyNotes}>
          {copied ? (
            <CheckIcon data-icon="inline-start" />
          ) : (
            <ClipboardTextIcon data-icon="inline-start" />
          )}
          Copy native histogram migration notes
        </Button>
        {pending ? (
          <Badge variant="outline">
            {pending.status === "proposed" ? "Proposed" : "Rule active"}: keeps{" "}
            {pending.kind === "keep_buckets" ? pending.buckets.length : 0}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
