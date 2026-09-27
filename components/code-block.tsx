import * as React from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

export function useCopy() {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback((text: string) => {
    void copyText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [])
  return { copied, copy }
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button size="xs" variant="secondary" className={className} onClick={() => copy(text)}>
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? "Copied" : label}
    </Button>
  )
}

export function CodeBlock({
  code,
  display,
  className,
  maxHeight = "max-h-96",
}: {
  code: string
  /** What to show when it differs from what gets copied (e.g. a masked token). */
  display?: string
  className?: string
  maxHeight?: string
}) {
  return (
    <div className={cn("relative min-w-0 rounded-2xl border border-frame-border bg-frame [corner-shape:squircle]", className)}>
      <pre className={cn("overflow-auto p-3 pr-20 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all", maxHeight)}>
        {display ?? code}
      </pre>
      <CopyButton text={code} className="absolute top-2 right-2" />
    </div>
  )
}
