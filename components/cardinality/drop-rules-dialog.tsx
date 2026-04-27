"use client"

import { Check, Copy, Layers, Trash2, X } from "lucide-react"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import {
  formatNumber,
  type Savings,
} from "@/lib/cardinality/dashboard-helpers"
import type {
  DropRuleMetricInput,
  DropRuleMode,
  SnapshotResponse,
} from "@/lib/prometheus/types"
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
  exportMetrics: DropRuleMetricInput[]
  snapshot: SnapshotResponse | null
  savings: Savings
  selectedLabelCount: number
  dropRuleMode: DropRuleMode
  generatedConfigs: { prometheusYaml: string; alloyHcl: string }
  copiedYaml: boolean
  copiedHcl: boolean
  onModeChange: (mode: DropRuleMode) => void
  onRemoveMetric: (metric: string) => void
  onClearAll: () => void
  onCopyYaml: () => void
  onCopyHcl: () => void
}

export function DropRulesDialog({
  open,
  onOpenChange,
  exportMetrics,
  snapshot,
  savings,
  selectedLabelCount,
  dropRuleMode,
  generatedConfigs,
  copiedYaml,
  copiedHcl,
  onModeChange,
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
              {exportMetrics.filter((item) => item.dropMetric).length} metric
              {exportMetrics.filter((item) => item.dropMetric).length !== 1 ? "s" : ""} selected
            </span>
            {selectedLabelCount > 0 ? (
              <>
                <span>·</span>
                <span>
                  {selectedLabelCount} label key
                  {selectedLabelCount !== 1 ? "s" : ""} selected
                </span>
              </>
            ) : null}
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
            {exportMetrics.map((item) => {
              const info = snapshot?.metrics.find((m) => m.metric === item.metric)
              return (
                <div
                  key={item.metric}
                  className="flex flex-col gap-2 rounded-lg px-1 py-1.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{item.metric}</span>
                        {item.dropMetric ? <span className="text-xs text-muted-foreground">metric drop</span> : null}
                        {(item.droppedLabels?.length ?? 0) > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {item.droppedLabels?.length} label key{item.droppedLabels?.length !== 1 ? "s" : ""}
                          </span>
                        ) : null}
                      </div>
                      {info ? (
                        <span
                          className="text-xs"
                          style={getScaleTextStyle(info.percentageOfTotal, "risk")}
                        >
                          {formatNumber(info.seriesCount)} series
                        </span>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemoveMetric(item.metric)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  {(item.droppedLabels?.length ?? 0) > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {item.droppedLabels?.map((label) => (
                        <span
                          key={`${item.metric}-${label}`}
                          className="rounded-full border px-2 py-1 font-mono text-[11px] text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </ScrollArea>
        <Separator />

        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3">
            <div>
              <p className="text-sm font-medium">Export layout</p>
              <p className="text-xs text-muted-foreground">
                Choose whether to emit one rule for all metrics or separate
                rules grouped by each metric top job.
              </p>
              <p className="text-xs text-muted-foreground">
                Selected label keys are exported as metric-scoped value blanking rules rather than pure labeldrop.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={dropRuleMode === "combined" ? "default" : "outline"}
                onClick={() => onModeChange("combined")}
              >
                Single combined rule
              </Button>
              <Button
                type="button"
                size="sm"
                variant={
                  dropRuleMode === "split-by-job" ? "default" : "outline"
                }
                onClick={() => onModeChange("split-by-job")}
              >
                Split by job
              </Button>
            </div>
            {dropRuleMode === "split-by-job" ? (
              <p className="text-xs text-muted-foreground">
                Metrics without a detected top job fall back to a name-only drop
                rule.
              </p>
            ) : null}
          </div>
        </div>
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
