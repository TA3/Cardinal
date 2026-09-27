import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Styled tooltip for an icon-only control; the child keeps its own aria-label. */
export function Tip({
  label,
  side = "top",
  children,
}: {
  label: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
