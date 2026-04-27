"use client"

import { Check, Copy, Layers, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatNumber,
  seriesColor,
  type Savings,
} from "@/lib/cardinality/dashboard-helpers"
import type { SnapshotResponse } from "@/lib/prometheus/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

interface DropRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dropMetrics: string[]
  snapshot: SnapshotResponse | null
  savings: Savings
  generatedConfigs: { prometheusYaml: string; alloyHcl: string }
  copiedYaml: boolean
  copiedHcl: boolean
  onRemoveMetric: (metric: string) => void
  onClearAll: () => void
  onCopyYaml: () => void
  onCopyHcl: () => void
}

export function DropRulesDialog({
  open,
  onOpenChange,
  dropMetrics,
  snapshot,
  savings,
  generatedConfigs,
  copiedYaml,
  copiedHcl,
  onRemoveMetric,
  onClearAll,
  onCopyYaml,
  onCopyHcl,
}: DropRulesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90svh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Layers className="size-5" />
            Drop Rules
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>
              {dropMetrics.length} metric
              {dropMetrics.length !== 1 ? "s" : ""} selected
            </span>
            <span>·</span>
            <span>
              {savings.isEstimate ? "~" : ""}
              {formatNumber(savings.savedSeries)} series removed
            </span>
            <span>·</span>
            <span className="font-medium text-foreground">
              {savings.percent.toFixed(1)}% reduction
            </span>
          </div>
          <Progress value={savings.percent} className="mt-2 h-2" />
        </DialogHeader>
        <Separator />

        {/* Selected metrics list */}
        <ScrollArea className="max-h-64 flex-1 overflow-y-auto px-6 py-3">
          <div className="flex flex-col gap-0.5">
            {dropMetrics.map((metric) => {
              const info = snapshot?.metrics.find((m) => m.metric === metric)
              return (
                <div
                  key={metric}
                  className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5"
                >
                  <span className="font-mono text-sm">{metric}</span>
                  <div className="flex items-center gap-3">
                    {info ? (
                      <span
                        className={cn(
                          "text-xs",
                          seriesColor(info.percentageOfTotal)
                        )}
                      >
                        {formatNumber(info.seriesCount)} series
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemoveMetric(metric)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
        <Separator />

        {/* Config export tabs */}
        <div className="flex-1 overflow-auto px-6 py-4">
          <Tabs defaultValue="yaml">
            <TabsList className="w-full">
              <TabsTrigger value="yaml" className="flex-1">
                Prometheus YAML
              </TabsTrigger>
              <TabsTrigger value="hcl" className="flex-1">
                Grafana Alloy HCL
              </TabsTrigger>
            </TabsList>
            <TabsContent value="yaml" className="mt-3">
              <div className="relative">
                <Textarea
                  readOnly
                  className="min-h-40 font-mono text-xs"
                  value={generatedConfigs.prometheusYaml}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-2"
                  onClick={onCopyYaml}
                >
                  {copiedYaml ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copiedYaml ? "Copied!" : "Copy"}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="hcl" className="mt-3">
              <div className="relative">
                <Textarea
                  readOnly
                  className="min-h-40 font-mono text-xs"
                  value={generatedConfigs.alloyHcl}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-2"
                  onClick={onCopyHcl}
                >
                  {copiedHcl ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copiedHcl ? "Copied!" : "Copy"}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter className="px-6 pb-6">
          <Button variant="outline" onClick={onClearAll}>
            <Trash2 className="size-4" />
            Clear all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
