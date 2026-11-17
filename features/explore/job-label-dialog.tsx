import * as React from "react"
import { ArrowLeftIcon, CaretRightIcon, TagIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { connectionKey, useConnection, useMetricsTarget } from "@/hooks/use-cardinality"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { mergeChoicesFor } from "@/lib/core/backend-profile"
import {
  addJobLabelDrops,
  jobLabelPlan,
  removableJobLabel,
  type JobLabelMerge,
  type JobWork,
} from "@/lib/core/job-work"
import { jobLabel } from "@/lib/core/jobs"
import { fetchJobLabels, measureJobLabel } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

// Removing one label from every metric of a job, e.g. a pod hash or a
// container ID the exporter adds everywhere. It becomes one label drop per
// metric that carries it. Where series would fold together, the user says
// what happens; leaving those metrics alone is the default.

const MERGE_TEXT: Record<Exclude<JobLabelMerge, "skip">, string> = {
  aggregate: "Sum the series that fold together, so totals stay right.",
  drop: "Prometheus keeps one sample per folded group each scrape and rejects the rest as duplicates.",
}

export function JobLabelDialog({
  open,
  onOpenChange,
  job,
  work,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  job: string
  work: JobWork
}) {
  const [label, setLabel] = React.useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setLabel(null)
      }}
    >
      <DialogContent className="top-4 grid max-h-[calc(100svh-2rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:top-[10svh] sm:max-h-[80svh] sm:max-w-xl">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="size-4 text-brand-ink" weight="bold" aria-hidden />
            {label ? (
              <>
                Remove <span className="font-mono">{label}</span>
              </>
            ) : (
              "Remove a label everywhere"
            )}
          </DialogTitle>
          <DialogDescription>
            {label
              ? `From every metric of job ${jobLabel(job)} that carries it.`
              : `Pick a label to remove from every metric of job ${jobLabel(job)}. Labels like a pod hash or container ID often add series without adding meaning.`}
          </DialogDescription>
        </DialogHeader>
        {label ? (
          <LabelPlan key={label} job={job} label={label} work={work} onBack={() => setLabel(null)} onDone={() => onOpenChange(false)} />
        ) : (
          <LabelList job={job} onPick={setLabel} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function LabelList({ job, onPick }: { job: string; onPick: (label: string) => void }) {
  const connection = useConnection()
  const { data, isPending, error } = useQuery({
    queryKey: ["job-labels", connectionKey(connection), job],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchJobLabels(connection!, job, signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const labels = (data ?? []).filter((item) => removableJobLabel(item.label))
  return (
    <>
      <div className="overflow-y-auto p-3">
        {error ? (
          <p className="px-2 text-xs text-destructive">{error.message}</p>
        ) : isPending ? (
          <div className="flex flex-col gap-2 px-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-7" />
            ))}
          </div>
        ) : labels.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">This job's series carry no label that can go.</p>
        ) : (
          <ul className="flex flex-col">
            {labels.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => onPick(item.label)}
                  className="group/option flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.label}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{formatNumber(item.cardinality)} values</span>
                  <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/option:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function LabelPlan({
  job,
  label,
  work,
  onBack,
  onDone,
}: {
  job: string
  label: string
  work: JobWork
  onBack: () => void
  onDone: () => void
}) {
  const connection = useConnection()
  const { destination } = useMetricsTarget()
  const canSum = mergeChoicesFor(destination).includes("aggregate")
  const [merge, setMerge] = React.useState<JobLabelMerge>("skip")
  const { data, isPending, error, dataUpdatedAt } = useQuery({
    queryKey: ["job-label-impact", connectionKey(connection), job, label],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => measureJobLabel(connection!, job, label, signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
  // Metrics already gone from the job need nothing more.
  const gone = React.useMemo(() => new Set(work.metrics.filter((item) => item.state === "dropped").map((item) => item.metric)), [work.metrics])
  const rows = React.useMemo(() => (data ?? []).filter((row) => !gone.has(row.metric)), [data, gone])
  const plan = jobLabelPlan(rows, merge)
  const merging = plan.merging.length > 0

  const apply = () => {
    const before = useAppStore.getState().rules
    const rules = addJobLabelDrops(before, { job, label, targets: plan.targets, merge, measuredAt: new Date(dataUpdatedAt).toISOString() })
    useAppStore.setState({ rules })
    toast.success(`Removed ${label}`, {
      description: `From ${plan.targets.length} metric${plan.targets.length === 1 ? "" : "s"} of job ${jobLabel(job)}.`,
      action: { label: "Undo", onClick: () => useAppStore.setState({ rules: before }) },
    })
    onDone()
  }

  return (
    <>
      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <Button variant="ghost" size="sm" className="-ml-1 self-start" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Other labels
        </Button>
        {error ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            Counting series per metric with and without {label}…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No metric left in this job carries {label}.</p>
        ) : (
          <>
            <p className="text-sm">
              {formatNumber(rows.length)} metric{rows.length === 1 ? "" : "s"} carry it.{" "}
              {merging
                ? `On ${formatNumber(plan.merging.length)} of them, series that differ only by ${label} would fold together.`
                : `Every series stays distinct without it: this saves no series, it makes each one smaller.`}
            </p>
            {merging ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Where series fold together</span>
                <SegmentedControl
                  size="sm"
                  className="self-start"
                  aria-label={`What to do where removing ${label} folds series together`}
                  value={merge}
                  onValueChange={setMerge}
                  options={[
                    { value: "skip", label: "Leave alone" },
                    ...(canSum ? [{ value: "aggregate" as const, label: "Sum them" }] : []),
                    { value: "drop", label: "Drop anyway" },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  {merge !== "skip"
                    ? MERGE_TEXT[merge]
                    : plan.targets.length
                      ? "Leave those metrics alone; remove it only where every series stays distinct."
                      : "Leave them alone, so nothing changes."}
                </p>
                <ul className="flex flex-col gap-0.5 rounded-xl border border-border/60 p-1.5">
                  {plan.merging.slice(0, 6).map((row) => (
                    <li key={row.metric} className="flex items-center gap-3 px-1.5 py-0.5 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono">{row.metric}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatNumber(row.seriesBefore)} → {formatNumber(row.seriesAfter)}
                      </span>
                    </li>
                  ))}
                  {plan.merging.length > 6 ? (
                    <li className="px-1.5 py-0.5 text-[11px] text-muted-foreground">+{plan.merging.length - 6} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
      <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-2 border-t border-border/60 p-4">
        <span className="text-xs text-muted-foreground tabular-nums">
          {plan.targets.length ? (
            <>
              {formatNumber(plan.targets.length)} metric{plan.targets.length === 1 ? "" : "s"}
              {plan.savedSeries ? <span className="font-medium text-brand-ink"> · {formatDelta(-plan.savedSeries)} series</span> : null}
            </>
          ) : null}
        </span>
        <Button disabled={plan.targets.length === 0} onClick={apply}>
          {plan.targets.length
            ? `Remove from ${formatNumber(plan.targets.length)} metric${plan.targets.length === 1 ? "" : "s"}`
            : "Nothing to remove"}
        </Button>
      </DialogFooter>
    </>
  )
}
