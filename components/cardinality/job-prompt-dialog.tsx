"use client"

import { Check, ClipboardCopy, WandSparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

interface JobPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  job: string | null
  promptText: string
  isGenerating: boolean
  copied: boolean
  onGenerate: () => void
  onCopy: () => void
}

export function JobPromptDialog({
  open,
  onOpenChange,
  job,
  promptText,
  isGenerating,
  copied,
  onGenerate,
  onCopy,
}: JobPromptDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-4xl!">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparkles className="size-5" />
            AI Dashboard Prompt
          </DialogTitle>
          <DialogDescription>
            {job
              ? `Generated prompt for job: ${job}`
              : "Generate a Grafana dashboard prompt from this job's metrics."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            readOnly
            value={promptText}
            placeholder={
              isGenerating
                ? "Generating prompt..."
                : "Use Generate prompt to build an AI-ready dashboard prompt."
            }
            className="min-h-[380px] max-h-[600px] resize-y font-mono text-xs"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onGenerate}
            disabled={isGenerating || !job}
          >
            <WandSparkles data-icon="inline-start" />
            {isGenerating ? "Generating..." : "Regenerate"}
          </Button>
          <Button
            type="button"
            onClick={onCopy}
            disabled={isGenerating || promptText.length === 0}
          >
            {copied ? (
              <Check data-icon="inline-start" />
            ) : (
              <ClipboardCopy data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
