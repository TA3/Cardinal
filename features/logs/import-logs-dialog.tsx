import * as React from "react"
import { ClipboardTextIcon, UploadSimpleIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { CodeBlock } from "@/components/code-block"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { formatBytes } from "@/lib/core/bytes"
import { logsBytesQuery, logsCurl, logsSnapshotFromImport, logsStreamsQuery } from "@/lib/core/logs/import"
import { LOGS_RANGE_LABEL, LOGS_RANGES } from "@/lib/core/logs/snapshot"
import type { LogsRange } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// The logs twin of ImportSnapshotDialog: one LogQL query for bytes per
// service, and optionally one for streams per service, run wherever the user
// already has access. Nothing leaves this browser.

const RANGE_OPTIONS = LOGS_RANGES.map((value) => ({ value, label: value, title: `Last ${LOGS_RANGE_LABEL[value]}` }))

/** A textarea that also takes a file. */
function ResultField({ id, label, value, onChange, description }: { id: string; label: string; value: string; onChange: (value: string) => void; description: string }) {
  const fileInput = React.useRef<HTMLInputElement>(null)
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.csv,.txt,application/json,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) void file.text().then(onChange)
          }}
        />
        <Button type="button" size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>
          <UploadSimpleIcon data-icon="inline-start" />
          Upload
        </Button>
      </div>
      <Textarea
        id={id}
        className="max-h-48 min-h-24 font-mono text-xs"
        placeholder={'{"status":"success","data":{"resultType":"vector","result":[…]}}'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

export function ImportLogsDialog({ trigger }: { trigger?: React.ReactNode }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [range, setRange] = React.useState<LogsRange>(() => useAppStore.getState().logsSettings.range)
  const [label, setLabel] = React.useState("service_name")
  const [bytes, setBytes] = React.useState("")
  const [streams, setStreams] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const group = label.trim() || "service_name"
  const baseUrl = useAppStore.getState().logsSettings.baseUrl

  function load() {
    const state = useAppStore.getState()
    try {
      const snapshot = logsSnapshotFromImport({ bytes, streams, range })
      state.switchLogsConnection(
        { ...state.logsSettings, baseUrl: "", authMode: "none", instanceId: "", token: "", tenant: "", modeManual: false, range, groupLabel: snapshot.groupLabel },
        snapshot
      )
      void queryClient.invalidateQueries()
      toast.success(`Loaded ${formatBytes(snapshot.totals.bytes)} of logs over ${LOGS_RANGE_LABEL[range]}`, {
        description: `${snapshot.groupCount ?? snapshot.groups.length} values of ${snapshot.groupLabel}, read in this browser only.`,
      })
      setOpen(false)
      setBytes("")
      setStreams("")
      navigate(paths.logs)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setError(null)
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <ClipboardTextIcon data-icon="inline-start" />
            Paste a result
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Use logs without credentials</DialogTitle>
          <DialogDescription>
            Run these as instant LogQL queries where you already have access (Grafana Explore, logcli or curl) and paste the results. They are read
            in this browser only. Labels, patterns and impact checks need a live connection.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Range</FieldLabel>
              <SegmentedControl aria-label="Range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} className="self-start" />
            </Field>
            <Field>
              <FieldLabel htmlFor="logs-import-label">Group by</FieldLabel>
              <Input id="logs-import-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="service_name" />
            </Field>
          </div>
          <Field>
            <FieldLabel>1. Bytes per {group}</FieldLabel>
            <CodeBlock code={logsBytesQuery(range, group)} />
          </Field>
          <Field>
            <FieldLabel>2. Streams per {group} (optional)</FieldLabel>
            <CodeBlock code={logsStreamsQuery(range, group)} />
            <FieldDescription>
              In Grafana Explore, pick Instant, then Inspect → Data → Download CSV. Or call Loki directly, e.g.{" "}
              <code className="font-mono break-all">{logsCurl("…", baseUrl)}</code>
            </FieldDescription>
          </Field>
          <ResultField
            id="logs-import-bytes"
            label="Bytes result"
            value={bytes}
            onChange={(value) => {
              setBytes(value)
              setError(null)
            }}
            description="The JSON response, its result array, or the CSV download."
          />
          <ResultField
            id="logs-import-streams"
            label="Streams result (optional)"
            value={streams}
            onChange={(value) => {
              setStreams(value)
              setError(null)
            }}
            description="Without it, stream counts show as 0."
          />
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't read that</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" disabled={!bytes.trim()} onClick={load}>
            Load snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
