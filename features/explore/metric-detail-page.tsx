import * as React from "react"
import { XIcon } from "@phosphor-icons/react"
import { Link, useParams, useSearchParams } from "react-router"

import { jobPath } from "@/app/paths"
import { CopyButton } from "@/components/code-block"
import { Frame, FrameWell } from "@/components/frame"
import { Page, PageHeader } from "@/components/page"
import { PlanBar } from "@/components/plan-bar"
import { RequireSnapshot } from "@/components/require-snapshot"
import { DropScopeToggle } from "@/components/rule-parts"
import { Badge } from "@/components/ui/badge"
import type { DropScope } from "@/features/explore/drop-scope"
import { HOME, MetricWorkbench, type MetricPanel } from "@/features/explore/metric-workbench"
import { useMetricWork } from "@/features/explore/use-metric-work"
import { histogramFamily } from "@/lib/core/families"
import { jobFromParam, jobLabel, jobToParam } from "@/lib/core/jobs"
import type { Snapshot } from "@/lib/core/snapshot"

// A metric's own page: the same workbench as the metric dialogs, with the
// view (?job=) and the open tool (?label=, ?view=) in the URL so it can be
// linked and shared.

const VIEWS = new Set(["buckets", "jobs", "usage"])

function panelFrom(params: URLSearchParams, metric: string): MetricPanel {
  const label = params.get("label")
  // Links to `?label=le` on a bucket metric mean its buckets.
  if (label === "le" && histogramFamily(metric).part === "bucket") return { view: "buckets" }
  if (label) return { view: "label", label }
  const view = params.get("view")
  return view && VIEWS.has(view) ? ({ view } as MetricPanel) : HOME
}

function MetricDetail({ metric, snapshot }: { metric: string; snapshot: Snapshot }) {
  const summary = snapshot.metrics.find((item) => item.metric === metric)
  const [params, setParams] = useSearchParams()
  const jobParam = params.get("job")
  const job = jobParam === null ? undefined : jobFromParam(jobParam)
  const [scope, setScope] = React.useState<DropScope>("job")
  const { item, used } = useMetricWork(metric, job)
  const panel = panelFrom(params, metric)

  const update = (patch: Record<string, string | null>, push = false) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      // Opening a tool is a step back can undo; the rest replaces.
      { replace: !push }
    )
  const openPanel = (next: MetricPanel) =>
    update(
      {
        label: next.view === "label" ? next.label : null,
        view: next.view === "home" || next.view === "label" ? null : next.view,
      },
      next.view !== "home"
    )
  const link = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}${params.size ? `?${params}` : ""}`

  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <Badge variant="outline">Metric</Badge>
            {job !== undefined ? (
              <Badge variant="secondary" asChild>
                <button type="button" onClick={() => update({ job: null })} aria-label={`Show every job, not only ${jobLabel(job)}`}>
                  job {jobLabel(job)}
                  <XIcon data-icon="inline-end" />
                </button>
              </Badge>
            ) : summary?.topJob !== undefined ? (
              <Badge variant="ghost" asChild>
                <Link to={jobPath(summary.topJob)}>{jobLabel(summary.topJob)}</Link>
              </Badge>
            ) : null}
          </>
        }
        title={<span className="font-mono break-all">{metric}</span>}
        description={summary ? (job === undefined ? "Across every job" : `In job ${jobLabel(job)}`) : "Not in the current snapshot."}
        actions={
          <>
            {job !== undefined ? <DropScopeToggle value={scope} onChange={setScope} job={job} /> : null}
            <CopyButton text={link} label="Copy link" className="h-8 px-3" />
          </>
        }
      />
      {item ? (
        <Frame className="w-full max-w-4xl">
          <FrameWell className="bg-frame p-3 sm:p-4">
            <MetricWorkbench
              item={item}
              job={job}
              scope={scope}
              used={used}
              panel={panel}
              onPanel={openPanel}
              onJob={(next) => update({ job: next === undefined ? null : jobToParam(next), label: null })}
            />
          </FrameWell>
        </Frame>
      ) : null}
      <PlanBar />
    </Page>
  )
}

export function MetricDetailPage() {
  const { metric = "" } = useParams()
  return <RequireSnapshot>{(snapshot) => <MetricDetail key={metric} metric={metric} snapshot={snapshot} />}</RequireSnapshot>
}
