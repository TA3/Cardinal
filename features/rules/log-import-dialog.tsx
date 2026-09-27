import * as React from "react"
import { UploadSimpleIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { parseAlloyLogs } from "@/lib/core/logs/parse/alloy"
import { parseLokiLimits } from "@/lib/core/logs/parse/loki-limits"
import { parsePromtailLogs } from "@/lib/core/logs/parse/promtail"
import type { LogImportResult } from "@/lib/core/logs/parse/stages"
import { parseLogRuleSetJson } from "@/lib/core/logs/share"
import { useAppStore } from "@/lib/store/app-store"

type Format = "alloy" | "promtail" | "limits" | "json"

const PLACEHOLDER: Record<Format, string> = {
  alloy: `loki.process "drop" {
  forward_to = [loki.write.default.receiver]

  stage.match {
    selector = "{service_name=\\"api\\"} |~ \\"GET /health\\""
    action   = "drop"
  }
}`,
  promtail: `pipeline_stages:
  - match:
      selector: '{service_name="api"}'
      stages:
        - drop:
            source: level
            value: debug`,
  limits: `limits_config:
  retention_stream:
    - selector: '{namespace="dev"}'
      priority: 1
      period: 72h`,
  json: `{
  "format": "cardinal.logrules",
  "version": 1,
  "rules": [{ "kind": "drop_streams", "selector": [{ "label": "service_name", "op": "=", "value": "noisy" }] }]
}`,
}

const DESCRIPTION: Record<Format, string> = {
  alloy: "A loki.process block (or a whole Alloy config): stage.match drops, stage.drop, stage.sampling, stage.label_drop and stage.structured_metadata.",
  promtail: "pipeline_stages from a Promtail scrape config: match, drop, sampling, labeldrop and structured_metadata.",
  limits: "Loki limits_config (or runtime overrides) with retention_stream entries; each becomes a retention rule.",
  json: "A log rule set exported from Cardinal. Its rules arrive as proposals for you to review.",
}

function parse(format: Format, text: string): LogImportResult | string {
  try {
    if (format === "json") {
      const { rules, warnings } = parseLogRuleSetJson(text)
      return { rules, warnings, ruleCount: rules.length + warnings.length }
    }
    return format === "alloy" ? parseAlloyLogs(text) : format === "promtail" ? parsePromtailLogs(text) : parseLokiLimits(text)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Rules → Import under Logs: collector stages and Loki limits you already run come in active; shared JSON as proposals. */
export function LogImportDialog() {
  const addLogRules = useAppStore((state) => state.addLogRules)
  const log = useAppStore((state) => state.log)
  const [open, setOpen] = React.useState(false)
  const [format, setFormat] = React.useState<Format>("alloy")
  const [text, setText] = React.useState("")

  const result = React.useMemo(() => (text.trim() ? parse(format, text) : null), [format, text])
  const parsed = result && typeof result !== "string" ? result : null

  function submit() {
    if (!parsed?.rules.length) return
    const shared = format === "json"
    const rules = shared
      ? parsed.rules
      : parsed.rules.map((rule) => ({ ...rule, origin: "import" as const, status: "active" as const }))
    const { added, skipped } = addLogRules(rules)
    const summary = `${added} log rule${added === 1 ? "" : "s"} added${skipped ? `, ${skipped} already present` : ""}`
    log(`Imported log rules from ${format}: ${summary}`)
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
          <DialogTitle>Import existing log rules</DialogTitle>
          <DialogDescription>
            Paste the pipeline stages or retention you already run so Cardinal counts them and exports one combined set.
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
                { value: "alloy", label: "Alloy" },
                { value: "promtail", label: "Promtail" },
                { value: "limits", label: "Loki limits" },
                { value: "json", label: "Cardinal JSON", title: "A log rule set shared from Cardinal; imported as proposals" },
              ]}
              className="max-w-full self-start overflow-x-auto"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="log-import-text">Rules</FieldLabel>
            <Textarea
              id="log-import-text"
              className="min-h-48 font-mono text-xs"
              placeholder={PLACEHOLDER[format]}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <FieldDescription>{DESCRIPTION[format]}</FieldDescription>
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
