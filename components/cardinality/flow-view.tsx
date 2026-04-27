"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, Database, BarChart3 } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatNumber, seriesColor } from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"

const MAX_DISPLAYED_METRICS = 20

interface FlowViewProps {
  snapshot: SnapshotResponse
  onMetricClick: (metric: string) => void
  onJobClick: (job: string) => void
}

export function FlowView({ snapshot, onMetricClick, onJobClick }: FlowViewProps) {
  const [expandedJobs, setExpandedJobs] = React.useState<Set<string>>(new Set())

  function toggleJob(job: string) {
    setExpandedJobs((prev) => {
      const next = new Set(prev)
      if (next.has(job)) {
        next.delete(job)
      } else {
        next.add(job)
      }
      return next
    })
  }

  // Build a map of job → metrics from snapshot data
  const jobMetrics = React.useMemo(() => {
    const map = new Map<string, typeof snapshot.metrics>()
    for (const metric of snapshot.metrics) {
      const job = metric.topJob ?? "(unassigned)"
      if (!map.has(job)) {
        map.set(job, [])
      }
      map.get(job)!.push(metric)
    }
    // Sort metrics within each job by seriesCount desc
    for (const [, metrics] of map) {
      metrics.sort((a, b) => b.seriesCount - a.seriesCount)
    }
    return map
  }, [snapshot])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Database className="size-4" />
          Job → Metric flow
        </CardTitle>
        <CardDescription>
          Expand a job to explore its metrics. Click a metric to inspect labels.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[60vh]">
          <div className="divide-y">
            {snapshot.jobs.map((job) => {
              const isExpanded = expandedJobs.has(job.job)
              const metrics = jobMetrics.get(job.job) ?? []
              return (
                <div key={job.job}>
                  {/* Job row */}
                  <div
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/40"
                    onClick={() => toggleJob(job.job)}
                  >
                    <span className="text-muted-foreground">
                      {isExpanded ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </span>
                    <Database className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className="flex-1 truncate text-sm font-medium"
                      onClick={(e) => {
                        e.stopPropagation()
                        onJobClick(job.job)
                      }}
                    >
                      {job.job}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        seriesColor(job.percentageOfTotal)
                      )}
                    >
                      {formatNumber(job.seriesCount)}
                    </span>
                    <Badge
                      variant="secondary"
                      className="shrink-0 text-xs tabular-nums"
                    >
                      {job.metricCount}
                    </Badge>
                  </div>

                  {/* Expanded metric rows */}
                  {isExpanded && metrics.length > 0 ? (
                    <div className="border-l-2 border-muted/60 ml-6">
                      {metrics.slice(0, MAX_DISPLAYED_METRICS).map((metric, idx) => (
                        <div
                          key={metric.metric}
                          className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-muted/30"
                          onClick={() => onMetricClick(metric.metric)}
                        >
                          <BarChart3 className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate font-mono text-xs">
                            {metric.metric}
                          </span>
                          {idx < 3 ? (
                            <Badge className="shrink-0 text-xs">Top</Badge>
                          ) : null}
                          <span
                            className={cn(
                              "shrink-0 text-xs",
                              seriesColor(metric.percentageOfTotal)
                            )}
                          >
                            {formatNumber(metric.seriesCount)}
                          </span>
                        </div>
                      ))}
                      {metrics.length > MAX_DISPLAYED_METRICS ? (
                        <p className="px-4 py-2 text-xs text-muted-foreground">
                          +{metrics.length - MAX_DISPLAYED_METRICS} more metrics
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
