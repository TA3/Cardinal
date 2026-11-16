import * as React from "react"
import {
  CheckIcon,
  EyeSlashIcon,
  SigmaIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { scopeText } from "@/features/explore/drop-scope"
import { useUsageEvidence } from "@/features/rules/usage"
import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { labelEvidence } from "@/lib/core/grafana-usage"
import { unseenLabels } from "@/lib/core/opportunities"
import {
  activateOrCreate,
  ruleKey,
  type DropLabelsRule,
} from "@/lib/core/rules"
import { measureImpact } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// "Sum away what nobody sees": when the dashboard scan (or Adaptive Metrics)
// shows that no query reads some labels of a used metric, summing them away
// cuts active series while every query keeps its result. A banner on the
// Labels card says how much; the dialog lets the user pick the labels.

const NEVER = new Set(["job", "le", "__name__"])

interface LabelInfo {
  label: string
  cardinality: number
}

function useUnseen(metric: string, labels: LabelInfo[]) {
  const { byMetric, isPending } = useUsageEvidence([metric])
  const evidence = byMetric[metric]
  const unseen = React.useMemo(
    () =>
      unseenLabels(
        labels.filter((item) => item.cardinality > 1).map((item) => item.label),
        evidence
      ),
    [labels, evidence]
  )
  return { unseen, evidence, isPending }
}

function useAggregateImpact(
  metric: string,
  job: string | undefined,
  labels: string[],
  enabled: boolean
) {
  const connection = useConnection()
  return useQuery({
    queryKey: [
      "labels-drop-impact",
      connectionKey(connection),
      metric,
      labels,
      job ?? null,
    ],
    enabled: Boolean(connection) && enabled && labels.length > 0,
    queryFn: ({ signal }) =>
      measureImpact(
        connection!,
        {
          kind: "drop_labels",
          selector: job === undefined ? { metric } : { metric, job },
          labels,
        },
        signal
      ),
    staleTime: 5 * 60_000,
  })
}

/** One line on the Labels card when some labels are never seen by a query; opens the picker. */
export function UnseenLabelsBanner({
  metric,
  job,
  labels,
}: {
  metric: string
  job?: string
  labels: LabelInfo[]
}) {
  const { unseen, evidence } = useUnseen(metric, labels)
  const rules = useAppStore((state) => state.rules)
  const [open, setOpen] = React.useState(false)
  const covered = React.useMemo(() => {
    const key = ruleKey({
      kind: "drop_labels",
      selector: job === undefined ? { metric } : { metric, job },
    })
    const active = rules.find(
      (rule): rule is DropLabelsRule =>
        rule.kind === "drop_labels" &&
        rule.status === "active" &&
        ruleKey(rule) === key
    )
    return Boolean(
      active && unseen?.every((label) => active.labels.includes(label))
    )
  }, [rules, metric, job, unseen])
  const impact = useAggregateImpact(
    metric,
    job,
    unseen ?? [],
    Boolean(unseen?.length) && !covered
  )
  if (!unseen?.length || covered) return null
  const saved = impact.data
    ? impact.data.seriesBefore - impact.data.seriesAfter
    : null
  if (saved !== null && saved <= 0) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group/banner mb-3 flex w-full items-center gap-3 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-left outline-none hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <SigmaIcon
          className="size-4 shrink-0 text-brand-ink"
          weight="bold"
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-xs">
          <span className="font-medium">
            No query sees{" "}
            {unseen.length === 1 ? unseen[0] : `${unseen.length} labels`}.
          </span>{" "}
          <span className="text-muted-foreground">
            Sum {unseen.length === 1 ? "it" : "them"} away and every{" "}
            {evidence?.cloudUsage?.droppedLabels?.length
              ? "query"
              : "dashboard"}{" "}
            keeps its result.
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium text-brand-ink tabular-nums">
          {impact.isPending ? (
            <Spinner className="size-3.5" />
          ) : saved !== null ? (
            formatDelta(-saved)
          ) : null}
        </span>
        <span className="shrink-0 text-xs font-medium underline-offset-2 group-hover/banner:underline">
          Review
        </span>
      </button>
      <AggregateDialog
        open={open}
        onOpenChange={setOpen}
        metric={metric}
        job={job}
        labels={labels}
        unseen={unseen}
      />
    </>
  )
}

function AggregateDialog({
  open,
  onOpenChange,
  metric,
  job,
  labels,
  unseen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  metric: string
  job?: string
  labels: LabelInfo[]
  unseen: string[]
}) {
  const { evidence } = useUnseen(metric, labels)
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(unseen))
  const chosen = React.useMemo(() => Array.from(picked).sort(), [picked])
  const impact = useAggregateImpact(metric, job, chosen, open)
  const usages = evidence?.dashboards?.usages ?? []
  const candidates = labels.filter(
    (item) => !NEVER.has(item.label) && item.cardinality > 1
  )
  const seen = chosen.filter((label) => !unseen.includes(label))

  function add() {
    const rules = activateOrCreate(useAppStore.getState().rules, {
      kind: "drop_labels",
      selector: job === undefined ? { metric } : { metric, job },
      labels: chosen,
      onMerge: "aggregate",
      origin: "user",
      impact: impact.data,
      rationale: `No checked query reads ${chosen.join(", ")}: summed away, every dashboard keeps its result.`,
    })
    useAppStore.setState({ rules })
    toast.success("Aggregation added", {
      description: `${metric}: sum without ${chosen.join(", ")} (${scopeText(job)}).`,
    })
    onOpenChange(false)
  }

  const saved = impact.data
    ? impact.data.seriesBefore - impact.data.seriesAfter
    : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <SigmaIcon
              className="size-4 text-brand-ink"
              weight="bold"
              aria-hidden
            />
            Sum away labels nobody sees
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{metric}</span> keeps
            every label a query reads. The rest are summed away, so fewer series
            are stored and dashboards show the same numbers.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 overflow-y-auto p-3">
          {candidates.map((item) => {
            const on = picked.has(item.label)
            const used = labelEvidence(usages, item.label)
            const readers = new Set(
              [...used.used, ...used.shown].map(
                (usage) => usage.dashboard?.uid ?? usage.title
              )
            ).size
            const isUnseen = unseen.includes(item.label)
            return (
              <button
                key={item.label}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() =>
                  setPicked((previous) => {
                    const next = new Set(previous)
                    if (next.has(item.label)) next.delete(item.label)
                    else next.add(item.label)
                    return next
                  })
                }
                className={cn(
                  "flex items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                  on && "bg-foreground/[0.04]"
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-foreground/25"
                  )}
                  aria-hidden
                >
                  {on ? <CheckIcon className="size-3" weight="bold" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {item.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {formatNumber(item.cardinality)} values
                </span>
                <span
                  className={cn(
                    "flex w-36 shrink-0 items-center justify-end gap-1 text-[11px]",
                    isUnseen ? "text-muted-foreground" : "text-brand-ink"
                  )}
                >
                  {isUnseen ? (
                    <>
                      <EyeSlashIcon className="size-3" aria-hidden />
                      no query sees it
                    </>
                  ) : readers ? (
                    `read by ${readers} panel${readers === 1 ? "" : "s"}`
                  ) : (
                    "may be read"
                  )}
                </span>
              </button>
            )
          })}
        </div>
        <DialogFooter className="flex-col items-stretch gap-2 border-t border-border/60 p-4 sm:flex-col">
          <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
            {impact.isFetching ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" />
                Counting series…
              </span>
            ) : impact.data ? (
              <span>
                {formatNumber(impact.data.seriesBefore)}{" "}
                <span className="text-muted-foreground">→</span>{" "}
                <span className="font-medium">
                  {formatNumber(impact.data.seriesAfter)}
                </span>{" "}
                active series
              </span>
            ) : (
              <span className="text-muted-foreground">
                Pick labels to sum away.
              </span>
            )}
            {saved ? (
              <span className="text-sm font-medium text-brand-ink">
                {formatDelta(-saved)}
              </span>
            ) : null}
          </div>
          {seen.length ? (
            <p className="flex items-start gap-1.5 text-[11px] text-brand-ink">
              <WarningIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              Queries read {seen.join(", ")}: those panels will lose that
              breakdown.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Runs as Adaptive Metrics on Grafana Cloud, or a recording rule on
            remote write. Plain Prometheus scrapes can't sum, so the export asks
            first.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!chosen.length} onClick={add}>
              <SigmaIcon data-icon="inline-start" />
              Sum away {chosen.length || ""} label
              {chosen.length === 1 ? "" : "s"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
