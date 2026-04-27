"use client"

import { Check, ChevronRight, Database, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatNumber,
  formatPercent,
  seriesColor,
} from "@/lib/cardinality/dashboard-helpers"
import type { JobDrilldownResponse } from "@/lib/prometheus/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface JobDrilldownPanelProps {
  selectedJob: string | null
  jobDrilldown: JobDrilldownResponse | null
  isLoadingJob: boolean
  dropMetrics: string[]
  onMetricClick: (metric: string) => void
  onToggleDrop: (metric: string) => void
  onClose: () => void
}

export function JobDrilldownPanel({
  selectedJob,
  jobDrilldown,
  isLoadingJob,
  dropMetrics,
  onMetricClick,
  onToggleDrop,
  onClose,
}: JobDrilldownPanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Job drilldown
            </p>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4" />
              {selectedJob}
            </CardTitle>
            {jobDrilldown ? (
              <CardDescription>
                {formatNumber(jobDrilldown.totalSeries)} total series ·{" "}
                {jobDrilldown.metrics.length} metrics
              </CardDescription>
            ) : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoadingJob ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : null}
        {jobDrilldown ? (
          <ScrollArea className="max-h-[60vh] overflow-x-hidden">
          <Table className="w-full table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">Metric</TableHead>
                <TableHead className="w-24 text-right">Series</TableHead>
                <TableHead className="w-20 text-right">Share</TableHead>
                <TableHead className="w-24 text-right">Drop</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobDrilldown.metrics.map((m, index) => {
                const isDropped = dropMetrics.includes(m.metric)
                return (
                  <TableRow
                    key={`${m.job}-${m.metric}`}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => onMetricClick(m.metric)}
                  >
                    <TableCell className="max-w-0 w-full">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm truncate">{m.metric}</span>
                        {index < 3 ? (
                          <Badge variant="secondary">Top</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        seriesColor(m.percentageOfTotal)
                      )}
                    >
                      {formatNumber(m.seriesCount)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        seriesColor(m.percentageOfTotal)
                      )}
                    >
                      {formatPercent(m.percentageOfTotal)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={isDropped ? "secondary" : "outline"}
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleDrop(m.metric)
                        }}
                      >
                        {isDropped ? (
                          <Check className="size-3" />
                        ) : (
                          <X className="size-3" />
                        )}
                        {isDropped ? "Added" : "Drop"}
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
          </ScrollArea>
        ) : null}
      </CardContent>
    </Card>
  )
}
