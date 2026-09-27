import type * as React from "react"
import { ChartLineIcon, ScrollIcon } from "@phosphor-icons/react"

import { SIGNAL_LABEL, type Signal } from "@/lib/core/signals"
import { cn } from "@/lib/utils"

const ICON = { metrics: ChartLineIcon, logs: ScrollIcon } as const

/** A quiet chip naming the signal a shared page is showing, e.g. "Metrics"; `children` replaces the label. */
export function SignalBadge({ signal, children, className }: { signal: Signal; children?: React.ReactNode; className?: string }) {
  const Icon = ICON[signal]
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border border-frame-border bg-frame px-2 text-[11px] font-medium text-muted-foreground",
        className
      )}
    >
      <Icon aria-hidden className="size-3" />
      {children ?? SIGNAL_LABEL[signal]}
    </span>
  )
}
