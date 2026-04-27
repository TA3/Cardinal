"use client"

import { ChevronRight, Database, WandSparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import {
  formatNumber,
  formatPercent,
} from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  selectedJob: string | null
  activePanel: "job" | "metric" | null
  filterByJob: string | null
  onJobClick: (job: string) => void
  onGeneratePrompt: (job: string) => void
  onClearFilter: () => void
}

export function JobsTable({
  snapshot,
  selectedJob,
  activePanel,
  filterByJob,
  onJobClick,
  onGeneratePrompt,
  onClearFilter,
}: JobsTableProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
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
            {snapshot.jobs.map((job) => (
              <TableRow
                key={job.job}
                className={cn(
                  "cursor-pointer",
                  selectedJob === job.job && activePanel === "job"
                    ? "bg-muted/60"
                    : "hover:bg-muted/40"
                )}
                onClick={() => onJobClick(job.job)}
              >
                <TableCell className="font-medium">{job.job}</TableCell>
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
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
