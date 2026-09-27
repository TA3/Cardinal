import * as React from "react"
import { UploadSimpleIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { parseAlloyRelabel } from "@/lib/core/parse/alloy"
import { parsePrometheusRelabel } from "@/lib/core/parse/prometheus"
import type { ImportResult } from "@/lib/core/parse/relabel"
import { parseRuleSetJson } from "@/lib/core/share"
import { recordImport } from "@/features/rules/storage"
import { useAppStore } from "@/lib/store/app-store"

type Format = "prometheus" | "alloy" | "json"

const PLACEHOLDER: Record<Format, string> = {
  prometheus: `metric_relabel_configs:
  - source_labels: [__name__]
    regex: go_gc_duration_seconds|go_memstats_.*
    action: drop`,
  alloy: `prometheus.relabel "drop" {
  rule {
    source_labels = ["__name__"]
    regex         = "go_gc_duration_seconds"
    action        = "drop"
  }
}`,
  json: `{
  "format": "cardinal.rules",
  "version": 1,
  "rules": [{ "kind": "drop_metric", "metric": "go_gc_duration_seconds" }]
}`,
}

function parse(format: Format, text: string): ImportResult | string {
  try {
    if (format === "json") {
      const { rules, warnings } = parseRuleSetJson(text)
      return { rules, warnings, ruleCount: rules.length + warnings.length }
    }
    return format === "prometheus" ? parsePrometheusRelabel(text) : parseAlloyRelabel(text)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function ImportDialog() {
  const addRules = useAppStore((state) => state.addRules)
  const replaceRules = useAppStore((state) => state.replaceRules)
  const log = useAppStore((state) => state.log)
  const [open, setOpen] = React.useState(false)
  const [format, setFormat] = React.useState<Format>("prometheus")
  const [mode, setMode] = React.useState<"merge" | "replace">("merge")
  const [text, setText] = React.useState("")

  const result = React.useMemo(() => (text.trim() ? parse(format, text) : null), [format, text])
  const parsed = result && typeof result !== "string" ? result : null

  function submit() {
    if (!parsed?.rules.length) return
    // Relabel config is what already runs, so it comes in active and becomes the
    // export diff's baseline. A shared JSON rule set comes in as proposals.
    const shared = format === "json"
    const rules = shared ? parsed.rules : parsed.rules.map((rule) => ({ ...rule, status: "active" as const }))
    if (!shared) recordImport(rules, mode)
    const { added, skipped } = mode === "replace" && !shared ? replaceRules(rules) : addRules(rules)
    const summary = `${added} rule${added === 1 ? "" : "s"} added${skipped ? `, ${skipped} already present` : ""}`
    log(`Imported from ${format} (${mode}): ${summary}`)
    if (added) toast.success(`Imported: ${summary}`)
    else toast.info(`Nothing new: ${skipped} rule${skipped === 1 ? " is" : "s are"} already present`)
    setOpen(false)
    setText("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UploadSimpleIcon data-icon="inline-start" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import existing rules</DialogTitle>
          <DialogDescription>
            Paste relabel rules you already run so Cardinal counts them and exports one combined set. Full prometheus.yml files
            work too.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Format</FieldLabel>
            <SegmentedControl
              aria-label="Format"
              value={format}
              onValueChange={setFormat}
              options={[
                { value: "prometheus", label: "Prometheus YAML" },
                { value: "alloy", label: "Alloy" },
                { value: "json", label: "Cardinal JSON", title: "A rule set shared from Cardinal; imported as proposals" },
              ]}
              className="self-start"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="import-text">Rules</FieldLabel>
            <Textarea
              id="import-text"
              className="min-h-48 font-mono text-xs"
              placeholder={PLACEHOLDER[format]}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <FieldDescription>
              {format === "json"
                ? "A rule set exported from Cardinal. Its rules arrive as proposals for you to review."
                : "Supports metric drops (optionally per job), label removals and series drops scoped to a metric, and Cardinal's bucket rules. write_relabel_configs are read too."}
            </FieldDescription>
          </Field>
          {typeof result === "string" ? (
            <Alert variant="destructive">
              <AlertTitle>Could not parse</AlertTitle>
              <AlertDescription>{result}</AlertDescription>
            </Alert>
          ) : parsed ? (
            <Alert>
              <AlertTitle className="flex flex-wrap items-center gap-2">
                Found {parsed.rules.length} rule{parsed.rules.length === 1 ? "" : "s"}
                {parsed.warnings.length ? <Badge variant="outline">{parsed.warnings.length} skipped</Badge> : null}
              </AlertTitle>
              {parsed.warnings.length ? (
                <AlertDescription>
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs">
                    {parsed.warnings.slice(0, 5).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              ) : null}
            </Alert>
          ) : null}
          {format !== "json" ? (
            <Field orientation="horizontal">
              <FieldLabel>Existing rules</FieldLabel>
              <SegmentedControl
                size="sm"
                aria-label="Existing rules"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "merge", label: "Keep and merge" },
                  { value: "replace", label: "Replace" },
                ]}
              />
            </Field>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button disabled={!parsed?.rules.length} onClick={submit}>
            {format === "json" ? "Add" : "Import"} {parsed?.rules.length ? parsed.rules.length : ""} {format === "json" ? "proposals" : "rules"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
