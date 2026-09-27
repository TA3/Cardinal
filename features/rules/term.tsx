import * as React from "react"
import { ArrowRightIcon, BookOpenIcon } from "@phosphor-icons/react"

import { useShellActions } from "@/app/shell/shell-actions"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { GLOSSARY, type GlossaryKey } from "@/lib/core/glossary"
import { cn } from "@/lib/utils"

/**
 * A glossary term inline: dotted underline, and a small card with its short
 * definition on hover or focus (tap on touch). Enter, or "More in glossary"
 * in the card, opens the glossary sheet through the shell's `openGlossary`.
 */
export function Term({ id, children, className }: { id: GlossaryKey; children?: React.ReactNode; className?: string }) {
  const entry = GLOSSARY[id]
  const { openGlossary } = useShellActions()
  const [open, setOpen] = React.useState(false)
  // Radix tooltips ignore touch; a tap toggles the card instead.
  const tap = React.useRef({ touch: false, wasOpen: false })

  const showGlossary = () => {
    setOpen(false)
    openGlossary()
  }

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={(event) => {
          tap.current = { touch: event.pointerType !== "mouse", wasOpen: open }
        }}
        onClick={(event) => {
          if (!tap.current.touch) return
          // Keeps Radix from closing on click; the tap decides instead.
          event.preventDefault()
          setOpen(!tap.current.wasOpen)
        }}
      >
        <span
          tabIndex={0}
          data-slot="term"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            showGlossary()
          }}
          className={cn(
            "cursor-help underline decoration-muted-foreground/60 decoration-dotted decoration-[1.5px] underline-offset-[3px] transition-colors outline-none hover:decoration-foreground/70 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=delayed-open]:decoration-foreground/70 data-[state=instant-open]:decoration-foreground/70",
            className
          )}
        >
          {children ?? entry.term}
        </span>
      </TooltipTrigger>
      <TooltipContent className="w-72 flex-col items-start gap-1 px-3 pt-2.5 pb-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-white">
          <BookOpenIcon aria-hidden className="size-3.5 text-white/50" />
          {entry.term}
        </span>
        <span className="text-white/70">{entry.short}</span>
        <button
          type="button"
          onClick={showGlossary}
          className="group/more mt-1 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-white/55 transition-colors outline-none hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30"
        >
          More in glossary
          <ArrowRightIcon aria-hidden className="size-3 transition-transform group-hover/more:translate-x-0.5" />
        </button>
      </TooltipContent>
    </Tooltip>
  )
}
