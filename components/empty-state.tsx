import * as React from "react"

import { Frame, FrameWell } from "@/components/frame"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

/**
 * The one empty state: round icon, title, a line of help and optional actions.
 * `framed` wraps it in a double-bezel surface for use directly on a page.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  framed = false,
  compact = false,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  framed?: boolean
  compact?: boolean
  className?: string
}) {
  const empty = (
    <Empty className={cn(compact ? "gap-3 p-4" : "py-10", className)}>
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  )
  if (!framed) return empty
  return (
    <Frame>
      <FrameWell className="flex">{empty}</FrameWell>
    </Frame>
  )
}
