import * as React from "react"
import { LayoutGroup, motion } from "motion/react"

import { spring } from "@/components/motion"
import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  /** Small count shown after the label, e.g. rules per tab. */
  count?: number
  title?: string
}

/**
 * Pill-shaped single choice with the nav bar's sliding dark pill. Each
 * instance gets its own LayoutGroup so pills never jump between controls.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "default",
  stretch = false,
  className,
  "aria-label": ariaLabel,
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  size?: "default" | "sm"
  /** Fill the container width, splitting it evenly between options. */
  stretch?: boolean
  className?: string
  "aria-label": string
}) {
  const id = React.useId()
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onValueChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <LayoutGroup id={id}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className={cn(
          "isolate inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-frame-border bg-frame shadow-[0_1px_2px_rgba(0,0,0,0.06)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          size === "sm" ? "p-0.5" : "p-[3px]",
          stretch && "flex w-full",
          className
        )}
      >
        {options.map((option, index) => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              ref={(element) => {
                refs.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              title={option.title}
              onClick={() => onValueChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50",
                size === "sm" ? "h-[22px] px-2.5 text-xs" : "h-6 px-3 text-sm",
                stretch && "flex-1",
                active ? "text-background" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {active ? (
                <motion.span
                  layoutId="segment-pill"
                  transition={spring}
                  className="absolute inset-0 z-0 rounded-full bg-foreground shadow-[0_1px_2px_rgba(0,0,0,0.15)]"
                />
              ) : null}
              <span className="relative z-10">{option.label}</span>
              {option.count !== undefined ? (
                <span
                  className={cn(
                    "relative z-10 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums transition-colors",
                    active ? "bg-background/20 text-background" : "bg-well text-muted-foreground"
                  )}
                >
                  {option.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
