"use client"

import { ChevronRight, Database, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatNumber,
  formatPercent,
  seriesColor,
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
  onClearFilter: () => void
}

export function JobsTable({
  snapshot,
  selectedJob,
  activePanel,
  filterByJob,
  onJobClick,
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
                  className={cn("text-right", seriesColor(job.percentageOfTotal))}
                >
                  {formatNumber(job.seriesCount)}
                </TableCell>
                <TableCell
                  className={cn("text-right", seriesColor(job.percentageOfTotal))}
                >
                  {formatPercent(job.percentageOfTotal)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {job.metricCount}
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
