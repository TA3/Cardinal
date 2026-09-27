import * as React from "react"
import { WarningIcon } from "@phosphor-icons/react"

import { logGroupPath } from "@/app/paths"
import { SwapText } from "@/components/motion"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { useLogsSnapshotAge, useLogsSnapshotProgress, useRefreshLogsSnapshot } from "@/hooks/use-cardinality"
import type { LogsSnapshot } from "@/lib/core/logs/types"

// Pieces the logs streams, stream group and labels pages share.

/** Snapshot age and range, or the running refresh's progress. */
export function LogsSnapshotLine({ snapshot }: { snapshot: LogsSnapshot }) {
  const age = useLogsSnapshotAge()
  const progress = useLogsSnapshotProgress()
  const { isPending } = useRefreshLogsSnapshot()
  if (isPending) {
    const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null
    return (
      <span role="status" className="flex max-w-md flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          <SwapText value={progress?.phase ?? "Taking a logs snapshot"} />
          {percent !== null ? (
            <span className="tabular-nums">
              {progress!.done.toLocaleString()} / {progress!.total.toLocaleString()}
            </span>
          ) : null}
        </span>
        {percent !== null ? <Progress value={percent} aria-label="Snapshot progress" className="h-1" /> : null}
      </span>
    )
  }
  if (!age) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span title={age.capturedAt.toLocaleString()}>
        Snapshot <SwapText value={age.label} /> · last {snapshot.range}
      </span>
      {age.stale ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
          <WarningIcon className="size-3" />
          Stale: press R to refresh
        </span>
      ) : null}
    </span>
  )
}

/** A group's detail page, with the label it is grouped by in `?by=`. */
export function groupLink(value: string, by: string) {
  return `${logGroupPath(value)}?by=${encodeURIComponent(by)}`
}

/** Clicks on links and buttons inside a row keep their own behaviour. */
export function fromControl(event: React.MouseEvent) {
  return event.target instanceof Element && event.target.closest("a,button,[role=button],[role=radio],input") !== null
}

/** Updates search params in place (replace), dropping empty values. */
export function patchParams(current: URLSearchParams, patch: Record<string, string | null>) {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(key)
    else next.set(key, value)
  }
  return next
}
