import * as React from "react"
import { CaretLeftIcon, CaretRightIcon, CheckIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"

// The dialog for going through a list by hand (a job's metrics, a service's
// patterns): the item's own body, Prev/Next with J and K, and "Keep as is",
// which marks the item done and moves to the next one nobody decided yet.

/** Where an item stands: open (not decided), kept as is on purpose, or anything a rule does to it. */
export type WorkState = "open" | "kept" | "done"

/** Text fields and controls that use letters themselves. */
function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
}

/**
 * Keeps the last position while the dialog animates out, so its content
 * doesn't vanish before the dialog does.
 */
export function useShownIndex(index: number | null) {
  const [shown, setShown] = React.useState(index)
  if (index !== null && index !== shown) setShown(index)
  return index ?? shown ?? 0
}

export function WorkDialog({
  open,
  position,
  total,
  noun,
  state,
  onStep,
  onKeepAsIs,
  onUndoKeep,
  onClose,
  className,
  children,
}: {
  open: boolean
  position: number
  total: number
  /** What the items are, for labels: "metric", "pattern". */
  noun: string
  state: WorkState | undefined
  /** Moves by `step` (±1); out-of-range steps are ignored. */
  onStep: (step: number) => void
  onKeepAsIs: () => void
  onUndoKeep: () => void
  onClose: () => void
  className?: string
  /** The item: a DialogHeader and a scrolling body. */
  children: React.ReactNode
}) {
  const go = (step: number) => {
    const next = position + step
    if (next >= 0 && next < total) onStep(step)
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent
        // Pinned near the top: stepping through items and opening tools changes its height, so it grows down instead of jumping.
        className={
          className ??
          "top-4 grid max-h-[calc(100svh-2rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:top-[10svh] sm:max-h-[80svh] sm:max-w-2xl"
        }
        // Focus the dialog, not its first control (whose tooltip would pop up); J and K work from there.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        onKeyDown={(event) => {
          if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === "j") {
            event.preventDefault()
            go(1)
          } else if (event.key === "k") {
            event.preventDefault()
            go(-1)
          }
        }}
      >
        {children}
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-2 border-t border-border/60 p-3">
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label={`Previous ${noun}`} disabled={position === 0} onClick={() => go(-1)}>
              <CaretLeftIcon />
            </Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
              {position + 1} of {total}
            </span>
            <Button size="icon-sm" variant="ghost" aria-label={`Next ${noun}`} disabled={position >= total - 1} onClick={() => go(1)}>
              <CaretRightIcon />
            </Button>
            <span className="ml-1 hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
          {state === "open" ? (
            <Button variant="outline" onClick={onKeepAsIs}>
              <CheckIcon data-icon="inline-start" />
              Keep as is
            </Button>
          ) : state === "kept" ? (
            <Button variant="ghost" onClick={onUndoKeep}>
              Kept as is · Undo
            </Button>
          ) : position < total - 1 ? (
            <Button onClick={() => go(1)}>
              Next {noun}
              <CaretRightIcon data-icon="inline-end" />
            </Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The next position after `position` whose item is still open, or -1. */
export function nextOpenIndex<T>(queue: readonly T[], position: number, isOpen: (item: T) => boolean) {
  return queue.findIndex((item, at) => at > position && isOpen(item))
}
