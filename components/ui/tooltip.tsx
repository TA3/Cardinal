"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

/**
 * A short delay before the first tooltip, then instant for the next trigger
 * within `skipDelayDuration`, so sweeping across a toolbar feels immediate.
 */
function TooltipProvider({
  delayDuration = 250,
  skipDelayDuration = 450,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * The dark `tooltip-surface` pill, no arrow. It blurs and scales in from the
 * trigger's side (see `.tooltip-motion` in globals.css), and simply appears under
 * reduced motion. Pass `className` with `flex-col items-start p-3` for a card.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "tooltip-motion z-50 inline-flex w-fit max-w-[min(18rem,calc(100vw-1rem))] items-center gap-1.5 rounded-lg border border-tooltip-border bg-tooltip-surface px-2.5 py-1.5 text-xs leading-snug text-pretty text-white shadow-[0_1px_1px_rgba(0,0,0,0.25),0_8px_24px_-4px_rgba(0,0,0,0.3)] has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm **:data-[slot=kbd]:bg-white/10 **:data-[slot=kbd]:text-white/80",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
