import * as React from "react"
import { ClipboardTextIcon, UploadSimpleIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { CodeBlock } from "@/components/code-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { snapshotCurl, snapshotFromImport, SNAPSHOT_QUERY } from "@/lib/core/snapshot-import"
import { useAppStore } from "@/lib/store/app-store"

// The no-credentials way in: the user runs the snapshot query where they
// already have access and pastes the result. Nothing leaves this browser.

export function ImportSnapshotDialog({ trigger }: { trigger?: React.ReactNode }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)

  function load(value = text) {
    const state = useAppStore.getState()
    try {
      const snapshot = snapshotFromImport(value, state.settings.topN)
      state.switchConnection({ ...state.settings, baseUrl: "", authMode: "none", instanceId: "", token: "", tenant: "", modeManual: false }, snapshot)
      void queryClient.invalidateQueries()
      toast.success(`Loaded ${snapshot.totalSeries.toLocaleString()} active series`, {
        description: `${snapshot.metricCount.toLocaleString()} metrics across ${snapshot.jobs.length.toLocaleString()} jobs, read in this browser only.`,
      })
      setOpen(false)
      setText("")
      navigate(paths.overview)
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Use Cardinal without credentials</DialogTitle>
          <DialogDescription>
            Run one query wherever you already have access, then paste or upload its result. It is read in this browser only. Drilldowns and
            impact checks need a live connection; everything else works.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>1. Run this as an instant query</FieldLabel>
            <CodeBlock code={SNAPSHOT_QUERY} />
            <FieldDescription>
              In Grafana Explore, pick Instant and Table, then Inspect → Data → Download CSV. Or call the API directly:
            </FieldDescription>
            <CodeBlock code={snapshotCurl(useAppStore.getState().settings.baseUrl)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="snapshot-result">2. Paste the result</FieldLabel>
            <Textarea
              id="snapshot-result"
              className="min-h-40 font-mono text-xs"
              placeholder={'{"status":"success","data":{"resultType":"vector","result":[…]}}'}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setError(null)
              }}
            />
            <FieldDescription>The JSON response, its result array, or the CSV download.</FieldDescription>
          </Field>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't read that</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter>
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
              if (file) void file.text().then((value) => (setText(value), load(value)))
            }}
          />
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            <UploadSimpleIcon data-icon="inline-start" />
            Upload a file
          </Button>
          <Button type="button" disabled={!text.trim()} onClick={() => load()}>
            Load snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
