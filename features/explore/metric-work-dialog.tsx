import * as React from "react"
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { CopyButton } from "@/components/code-block"
import { nextOpenIndex, useShownIndex, WorkDialog } from "@/components/work-dialog"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { HOME, MetricWorkbench, type MetricPanel } from "@/features/explore/metric-workbench"
import { useMetricWork } from "@/features/explore/use-metric-work"
import { buildMetricWork, type MetricWork } from "@/lib/core/job-work"
import { jobLabel, jobToParam } from "@/lib/core/jobs"
import { useAppStore } from "@/lib/store/app-store"

// The metric workbench in a dialog, opened from a job's worklist or the
// Metrics list. J and K step through the list without closing it; in a job's
// view "Keep as is" marks a metric done and moves to the next open one.

/** The metric's page, in the same view (job) as the dialog. */
export function metricViewPath(metric: string, job: string | undefined) {
  return job === undefined ? metricPath(metric) : `${metricPath(metric)}?job=${encodeURIComponent(jobToParam(job))}`
}

export function MetricWorkDialog({
  job,
  queue,
  index,
  work,
  used,
  onIndex,
  onClose,
}: {
  /** The job whose view this is; undefined is every job (no "Keep as is" then). */
  job?: string
  /** The metrics to step through, in order. */
  queue: string[]
  /** Position in `queue`; null when closed. */
  index: number | null
  /** The job workbench's own work and usage; without them each metric is worked out as it opens. */
  work?: Map<string, MetricWork>
  used?: Record<string, boolean | undefined>
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const position = useShownIndex(index)
  const metric = queue[position]
  const own = useMetricWork(work || metric === undefined ? undefined : metric, job)
  const item = work ? (metric === undefined ? undefined : work.get(metric)) : own.item
  const isUsed = used && metric !== undefined ? used[metric] : own.used
  const setKeptAsIs = useAppStore((state) => state.setKeptAsIs)
  const keeps = job !== undefined
  /** Nobody decided on the metric yet in this job: no rule, not kept as is. */
  const isOpen = (name: string) => {
    const known = work?.get(name)
    if (known) return known.state === "open"
    const { rules, keptAsIs } = useAppStore.getState()
    const kept = job !== undefined && Object.hasOwn(keptAsIs, job) && keptAsIs[job].includes(name)
    return buildMetricWork({ metric: name, seriesCount: 0, rules, job, kept }).state === "open"
  }

  return (
    <WorkDialog
      open={index !== null && item !== undefined}
      position={position}
      total={queue.length}
      noun="metric"
      state={item === undefined ? undefined : !keeps ? "done" : item.state === "open" || item.state === "kept" ? item.state : "done"}
      onStep={(step) => onIndex(position + step)}
      onKeepAsIs={() => {
        if (!item || job === undefined) return
        setKeptAsIs(job, item.metric, true)
        // Then the next metric nobody decided yet, else close.
        const next = nextOpenIndex(queue, position, isOpen)
        if (next === -1) onClose()
        else onIndex(next)
      }}
      onUndoKeep={() => item && job !== undefined && setKeptAsIs(job, item.metric, false)}
      onClose={onClose}
      className="top-4 grid max-h-[calc(100svh-2rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:top-[8svh] sm:max-h-[84svh] sm:max-w-3xl"
    >
      {item ? <MetricWorkBody key={item.metric} job={job} item={item} used={isUsed} onClose={onClose} /> : null}
    </WorkDialog>
  )
}

function MetricWorkBody({ job, item, used, onClose }: { job?: string; item: MetricWork; used: boolean | undefined; onClose: () => void }) {
  const [panel, setPanel] = React.useState<MetricPanel>(HOME)
  return (
    <>
      <DialogHeader className="border-b border-border/60 p-5 pb-4">
        <DialogTitle className="pr-6 font-mono text-base break-all">{item.metric}</DialogTitle>
        <div className="flex flex-wrap items-center gap-2">
          <DialogDescription className="w-full sm:w-auto sm:min-w-0 sm:flex-1">{job === undefined ? "Across every job" : `In job ${jobLabel(job)}`}</DialogDescription>
          <CopyButton text={item.metric} label="Copy name" className="h-7 px-2" />
          <Button asChild size="sm" variant="ghost" className="h-7 px-2">
            <Link to={metricViewPath(item.metric, job)} onClick={onClose}>
              <ArrowsOutSimpleIcon data-icon="inline-start" />
              Open as page
            </Link>
          </Button>
        </div>
      </DialogHeader>
      <div className="overflow-y-auto p-3 sm:p-4">
        <MetricWorkbench item={item} job={job} used={used} panel={panel} onPanel={setPanel} onNavigate={onClose} />
      </div>
    </>
  )
}
