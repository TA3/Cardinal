import * as React from "react"
import { DownloadSimpleIcon, ExportIcon, FileArrowUpIcon, FileTextIcon, UploadSimpleIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { parseOwners, ownersToJson, ownersToText, type Owner } from "@/lib/core/owner-rules"
import { useAppStore } from "@/lib/store/app-store"

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Export menu: custom rules as JSON or text, and the Markdown summary of every owner. */
export function ExportMenu({ owners, summary }: { owners: Owner[]; summary: () => string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <ExportIcon data-icon="inline-start" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuLabel>Custom rules</DropdownMenuLabel>
        <DropdownMenuItem disabled={owners.length === 0} onSelect={() => downloadText("cardinal-owners.txt", ownersToText(owners), "text/plain")}>
          <FileTextIcon />
          Ownership file (.txt)
        </DropdownMenuItem>
        <DropdownMenuItem disabled={owners.length === 0} onSelect={() => downloadText("cardinal-owners.json", ownersToJson(owners), "application/json")}>
          <DownloadSimpleIcon />
          JSON
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Report</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            const text = summary()
            if (text) downloadText(`cardinal-owners-${new Date().toISOString().slice(0, 10)}.md`, text, "text/markdown")
          }}
        >
          <FileTextIcon />
          All owners summary (.md)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const SAMPLE = `[Payments] #5b7fd6
job payments-.*
metric payments_
label namespace payments-.*

[Platform]
job node|prometheus|kube-.*`

/** Paste or open an owner rules file (text format or JSON), then replace or append. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const owners = useAppStore((state) => state.attribution.owners)
  const setOwners = useAppStore((state) => state.setOwners)
  const [text, setText] = React.useState("")
  const fileRef = React.useRef<HTMLInputElement>(null)
  const parsed = React.useMemo(() => (text.trim() ? parseOwners(text) : null), [text])
  const ruleCount = parsed?.owners.reduce((sum, owner) => sum + owner.rules.length, 0) ?? 0

  const apply = (mode: "replace" | "append") => {
    if (!parsed?.owners.length) return
    setOwners(mode === "replace" ? parsed.owners : [...owners, ...parsed.owners])
    toast.success(`${mode === "replace" ? "Replaced owners with" : "Added"} ${parsed.owners.length} owner${parsed.owners.length === 1 ? "" : "s"}`)
    setText("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import custom rules</DialogTitle>
          <DialogDescription>
            Paste an ownership file or Cardinal owners JSON. Each <code className="font-mono text-xs">[Owner]</code> is followed by{" "}
            <code className="font-mono text-xs">job</code>, <code className="font-mono text-xs">metric</code> or{" "}
            <code className="font-mono text-xs">label &lt;name&gt;</code> lines with a regex.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Owner rules file"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={SAMPLE}
          spellCheck={false}
          className="min-h-48 font-mono text-xs"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.json,.codeowners,text/plain,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) void file.text().then(setText)
          }}
        />
        {parsed ? (
          <div className="flex flex-col gap-1 text-sm" aria-live="polite">
            <span className={parsed.owners.length ? "text-foreground" : "text-destructive"}>
              {parsed.owners.length
                ? `${parsed.owners.length} owner${parsed.owners.length === 1 ? "" : "s"}, ${ruleCount} rule${ruleCount === 1 ? "" : "s"}`
                : "No owners found."}
            </span>
            {parsed.errors.length ? (
              <ul className="max-h-24 overflow-auto text-xs text-destructive">
                {parsed.errors.slice(0, 20).map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <FileArrowUpIcon data-icon="inline-start" />
            Open file…
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {owners.length ? (
              <Button variant="outline" disabled={!parsed?.owners.length} onClick={() => apply("append")}>
                Add to current
              </Button>
            ) : null}
            <Button disabled={!parsed?.owners.length} onClick={() => apply("replace")}>
              <UploadSimpleIcon data-icon="inline-start" />
              {owners.length ? "Replace owners" : "Import"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
