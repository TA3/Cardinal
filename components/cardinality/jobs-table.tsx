"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ChevronRight, Database, WandSparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import {
  formatNumber,
  formatPercent,
} from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface JobsTableProps {
  snapshot: SnapshotResponse
  dropMetrics: string[]
  selectedJob: string | null
  activePanel: "job" | "metric" | null
  filterByJob: string | null
  onJobClick: (job: string) => void
  onGeneratePrompt: (job: string) => void
  onClearFilter: () => void
}

export function JobsTable({
  snapshot,
  dropMetrics,
  selectedJob,
  activePanel,
  filterByJob,
  onJobClick,
  onGeneratePrompt,
  onClearFilter,
}: JobsTableProps) {
  const droppedMetrics = new Set(dropMetrics)
  const savedPercentByJob = snapshot.metrics.reduce<Record<string, number>>((acc, metric) => {
    if (!metric.topJob || !droppedMetrics.has(metric.metric)) {
      return acc
    }

    acc[metric.topJob] = (acc[metric.topJob] ?? 0) + metric.seriesCount
    return acc
  }, {})

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Jobs
        </p>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="font-heading flex items-center gap-2">
              <Database className="size-4" />
              Jobs by total contribution
            </CardTitle>
            <CardDescription>
              Click a row to filter metrics below and inspect the job in the
              side panel.
            </CardDescription>
          </div>
          {filterByJob ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onClearFilter}
            >
              <X className="size-3.5" />
              Clear filter
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead className="text-right">Series</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Metrics</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.jobs.map((job) => {
              const savedSeries = savedPercentByJob[job.job] ?? 0
              const savedPercent = job.seriesCount > 0 ? (savedSeries / job.seriesCount) * 100 : 0

              return (
                <TableRow
                  key={job.job}
                  className={cn(
                    "cursor-pointer transition-colors text-sm",
                    selectedJob === job.job && activePanel === "job"
                      ? "bg-primary/10 border-l-[3px] border-primary"
                      : "hover:bg-muted/40 border-l-[3px] border-transparent"
                  )}
                  onClick={() => onJobClick(job.job)}
                >
                  <TableCell className="font-mono font-medium">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{job.job}</span>
                      {savedSeries > 0 ? (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {formatPercent(savedPercent)} saved
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    className="text-right"
                    style={getScaleTextStyle(job.percentageOfTotal, "risk")}
                  >
                    {formatNumber(job.seriesCount)}
                  </TableCell>
                  <TableCell
                    className="text-right"
                    style={getScaleTextStyle(job.percentageOfTotal, "risk")}
                  >
                    {formatPercent(job.percentageOfTotal)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {job.metricCount}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation()
                        onGeneratePrompt(job.job)
                      }}
                    >
                      <WandSparkles data-icon="inline-start" />
                    </Button>
                  </TableCell>
                  <TableCell className="w-8 text-muted-foreground">
                    <ChevronRight className="size-4" />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
