"use client"

import * as React from "react"
import { FileUp, AlertTriangle, CheckCircle2 } from "lucide-react"

import {
  parseAlloyRules,
  parsePrometheusRules,
  toSelectedLabelsByMetric,
  type ParsedImportRules,
} from "@/lib/cardinality/import-config"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

type ImportFormat = "prometheus" | "alloy"
type ImportMode = "merge" | "replace"

interface ImportRulesResult {
  dropMetrics: string[]
  selectedLabelsByMetric: Record<string, string[]>
  warnings: string[]
  format: ImportFormat
  ruleCount: number
}

interface ImportRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (result: ImportRulesResult, mode: ImportMode) => void
}

const PROMETHEUS_PLACEHOLDER = `metric_relabel_configs:
  - source_labels: [job, __name__, disk_id]
    regex: "ovirt-exporters;ovirt_vm_disk_actual_size_bytes;(.+)"
    target_label: disk_id
    replacement: ""
    action: replace`

const ALLOY_PLACEHOLDER = `prometheus.relabel "drop_metrics" {
  rule {
    source_labels = ["job", "__name__"]
    action        = "drop"
    regex         = "windows_exporter;(windows_service_info|windows_service_state)"
  }
}`

export function ImportRulesDialog({
  open,
  onOpenChange,
  onImport,
}: ImportRulesDialogProps) {
  const [format, setFormat] = React.useState<ImportFormat>("prometheus")
  const [importMode, setImportMode] = React.useState<ImportMode>("merge")
  const [text, setText] = React.useState("")
  const [parseError, setParseError] = React.useState<string | null>(null)
  const [parsed, setParsed] = React.useState<ParsedImportRules | null>(null)

  function resetLocalState() {
    setText("")
    setParsed(null)
    setParseError(null)
    setImportMode("merge")
    setFormat("prometheus")
  }

  function handleParse() {
    setParseError(null)
    if (!text.trim()) {
      setParsed(null)
      setParseError("Paste a Prometheus YAML or Alloy HCL rule set first.")
      return
    }

    try {
      const output =
        format === "prometheus"
          ? parsePrometheusRules(text)
          : parseAlloyRules(text)

      setParsed(output)

      if (
        output.dropMetrics.length === 0 &&
        output.labelDrops.length === 0 &&
        output.ruleCount > 0
      ) {
        setParseError(
          "No supported drop/replace rule patterns were detected in the pasted input."
        )
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to parse pasted rules"
      setParsed(null)
      setParseError(message)
    }
  }

  function handleImport() {
    if (!parsed) {
      return
    }

    onImport(
      {
        dropMetrics: parsed.dropMetrics,
        selectedLabelsByMetric: toSelectedLabelsByMetric(parsed.labelDrops),
        warnings: parsed.warnings,
        format,
        ruleCount: parsed.ruleCount,
      },
      importMode
    )

    onOpenChange(false)
    resetLocalState()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          resetLocalState()
        }
      }}
    >
      <DialogContent className="max-h-[70svh] max-w-6xl! overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2 font-heading">
            <FileUp className="size-4" />
            Import Existing Rules
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Paste Prometheus metric relabel YAML or Grafana Alloy HCL rules, parse them,
            and populate your drop metric + label selections automatically.
          </p>
        </DialogHeader>

        <Separator />

        <div className="flex flex-col gap-4 px-6 py-4">
          <Tabs
            value={format}
            onValueChange={(value) => {
              setFormat(value as ImportFormat)
              setParsed(null)
              setParseError(null)
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="prometheus" className="flex-1">
                Prometheus YAML
              </TabsTrigger>
              <TabsTrigger value="alloy" className="flex-1">
                Grafana Alloy HCL
              </TabsTrigger>
            </TabsList>
            <TabsContent value="prometheus" className="mt-3">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={PROMETHEUS_PLACEHOLDER}
                className="min-h-52 max-h-84 font-mono text-[11px] overflow-auto"
              />
            </TabsContent>
            <TabsContent value="alloy" className="mt-3">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={ALLOY_PLACEHOLDER}
                className="min-h-52 max-h-84 font-mono text-[11px] overflow-auto"
              />
            </TabsContent>
          </Tabs>

          <div className="flex flex-wrap items-center justify-between gap-2 divide-x">
            <Button type="button" variant="outline" onClick={handleParse}>
              Parse rules
            </Button>
            <div className="flex items-center gap-0">
                <Button
                type="button"
                variant={importMode === "merge" ? "default" : "outline"}
                onClick={() => setImportMode("merge")}
                className="rounded-r-none border-r-0"
                >
                Merge with existing
                </Button>
                <Button
                type="button"
                variant={importMode === "replace" ? "default" : "outline"}
                onClick={() => setImportMode("replace")}
                className="rounded-l-none border-l-0"
                >
                Replace existing
                </Button>
            </div>
          </div>

          {parseError ? (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Parse issue</AlertTitle>
              <AlertDescription>{parseError}</AlertDescription>
            </Alert>
          ) : null}

          {parsed ? (
            <div className="rounded-lg border bg-surface-subtle p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                {!parseError && parsed.warnings.length === 0 ? (
                  <CheckCircle2 className="size-4 text-green-500" />
                ) : <AlertTriangle className="size-4 text-yellow-500" />}
                <span className="font-medium text-foreground">
                  Parsed {parsed.ruleCount} rule{parsed.ruleCount !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">
                  {parsed.dropMetrics.length} metric drop
                  {parsed.dropMetrics.length !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">
                  {parsed.labelDrops.length} label rewrite
                  {parsed.labelDrops.length !== 1 ? "s" : ""}
                </span>
                {parsed.skippedCount > 0 ? (
                  <span className="text-muted-foreground">
                    {parsed.skippedCount} skipped
                  </span>
                ) : null}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border bg-background p-2">
                  <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                    Metric Drops
                  </p>
                  <ScrollArea className="h-28">
                    <div className="flex flex-col gap-1">
                      {parsed.dropMetrics.length > 0 ? (
                        parsed.dropMetrics.map((metric) => (
                          <span key={metric} className="font-mono text-xs">
                            {metric}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">None detected</span>
                      )}
                    </div>
                  </ScrollArea>
                </div>

                <div className="rounded-md border bg-background p-2">
                  <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                    Label Rewrites
                  </p>
                  <ScrollArea className="h-28">
                    <div className="flex flex-col gap-1">
                      {parsed.labelDrops.length > 0 ? (
                        parsed.labelDrops.map((item) => (
                          <span
                            key={`${item.metric}::${item.label}`}
                            className="font-mono text-xs"
                          >
                            {item.metric} [{item.label}]
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">None detected</span>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>

              {parsed.warnings.length > 0 ? (
                <div className="mt-3 rounded-md border border-dashed p-2">
                  <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                    Warnings
                  </p>
                  <ScrollArea className="h-20">
                    <div className="flex flex-col gap-1">
                      {parsed.warnings.map((warning) => (
                        <span key={warning} className="text-xs text-muted-foreground">
                          {warning}
                        </span>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="px-6 pb-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              !parsed ||
              (parsed.dropMetrics.length === 0 && parsed.labelDrops.length === 0)
            }
          >
            Import selection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
