import * as React from "react"
import { CheckIcon, CopyIcon, DownloadSimpleIcon, FileTextIcon } from "@phosphor-icons/react"

import { EmptyState } from "@/components/empty-state"
import { readPricePer1k, readPricePerGB } from "@/components/cost-text"
import { useCopy } from "@/components/code-block"
import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { buildLogsCsv, buildLogsMarkdownReport } from "@/features/logs/report"
import { buildMarkdownReport, buildMetricsCsv } from "@/features/overview/report"
import { useSignal } from "@/hooks/use-signal"
import { useAppStore } from "@/lib/store/app-store"

type Format = "markdown" | "csv"

const FORMAT_OPTIONS = [
  { value: "markdown", label: "Markdown", title: "Summary, top metrics and jobs, rules with savings" },
  { value: "csv", label: "CSV", title: "Every metric with series, share and top job" },
] as const

const LOGS_FORMAT_OPTIONS = [
  { value: "markdown", label: "Markdown", title: "Summary, top services and labels, log rules" },
  { value: "csv", label: "CSV", title: "Every group with bytes, share and streams" },
] as const

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl || undefined
  }
}

/** "Export report": the snapshot and rules as Markdown (download or copy) or a metrics CSV. */
export function ReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const snapshot = useAppStore((state) => state.snapshot)
  const rules = useAppStore((state) => state.rules)
  const drilldowns = useAppStore((state) => state.drilldowns)
  const settings = useAppStore((state) => state.settings)
  // Under Logs the report covers the logs snapshot.
  const logs = useSignal() === "logs"
  const logsSnapshot = useAppStore((state) => state.logsSnapshot)
  const logsBaseUrl = useAppStore((state) => state.logsSettings.baseUrl)
  const logRules = useAppStore((state) => (state as unknown as { logRules?: unknown }).logRules)
  const [format, setFormat] = React.useState<Format>("markdown")
  const { copied, copy } = useCopy()

  const text = React.useMemo(() => {
    if (!open) return ""
    if (logs) {
      if (!logsSnapshot) return ""
      return format === "markdown"
        ? buildLogsMarkdownReport({ snapshot: logsSnapshot, logRules, pricePerGB: readPricePerGB(settings), source: hostOf(logsBaseUrl) })
        : buildLogsCsv(logsSnapshot)
    }
    if (!snapshot) return ""
    return format === "markdown"
      ? buildMarkdownReport({ snapshot, rules, drilldowns, pricePer1k: readPricePer1k(settings), source: hostOf(settings.baseUrl) })
      : buildMetricsCsv(snapshot)
  }, [open, logs, logsSnapshot, logRules, logsBaseUrl, snapshot, rules, drilldowns, settings, format])

  const hasSnapshot = logs ? Boolean(logsSnapshot) : Boolean(snapshot)
  const rowCount = logs ? (logsSnapshot?.groups.length ?? 0) : (snapshot?.metrics.length ?? 0)
  const stamp = ((logs ? logsSnapshot?.capturedAt : snapshot?.capturedAt) ?? new Date().toISOString()).slice(0, 10)
  const filename =
    format === "markdown" ? `cardinal-${logs ? "logs-" : ""}report-${stamp}.md` : `cardinal-${logs ? "logs" : "metrics"}-${stamp}.csv`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export report</DialogTitle>
          <DialogDescription>
            Share the {logs ? "logs " : ""}snapshot and your rules. Nothing leaves this tab until you download or copy it.
          </DialogDescription>
        </DialogHeader>
        {hasSnapshot ? (
          <>
            <SegmentedControl aria-label="Report format" value={format} onValueChange={setFormat} options={logs ? LOGS_FORMAT_OPTIONS : FORMAT_OPTIONS} className="self-start" />
            <pre
              aria-label={format === "markdown" ? "Markdown preview" : "CSV preview"}
              tabIndex={0}
              className="max-h-[45svh] min-w-0 overflow-auto rounded-2xl border border-frame-border bg-frame p-3 font-mono text-xs leading-relaxed whitespace-pre [corner-shape:squircle]"
            >
              {format === "csv" ? text.split("\n").slice(0, 60).join("\n") + (rowCount > 59 ? "\n…" : "") : text}
            </pre>
            <DialogFooter>
              {format === "markdown" ? (
                <Button variant="outline" onClick={() => copy(text)}>
                  {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                  {copied ? "Copied" : "Copy Markdown"}
                </Button>
              ) : null}
              <Button onClick={() => downloadText(filename, text, format === "markdown" ? "text/markdown" : "text/csv")}>
                <DownloadSimpleIcon data-icon="inline-start" />
                Download {format === "markdown" ? ".md" : ".csv"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <EmptyState
            icon={FileTextIcon}
            title="No snapshot yet"
            description={logs ? "Connect a logs source and take a snapshot to export a logs report." : "Connect a data source and take a snapshot to export a report."}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
