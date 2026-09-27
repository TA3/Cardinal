import * as React from "react"
import { CaretRightIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { cn } from "@/lib/utils"

// Double-bezel surface: a white frame (header lives in the rim) around a soft
// inset well that holds the content.

export function Frame({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="frame"
      className={cn(
        "flex min-w-0 flex-col rounded-[26px] border border-frame-border bg-frame p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [corner-shape:squircle]",
        className
      )}
      {...props}
    />
  )
}

export function FrameHeader({
  icon: Icon,
  title,
  meta,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  meta?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-h-10 items-center justify-between gap-3 px-3.5 py-2", className)}>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
        <span className="truncate font-medium" title={typeof title === "string" ? title : undefined}>
          {title}
        </span>
        {meta ? <span className="truncate text-muted-foreground">{meta}</span> : null}
      </div>
      {action}
    </div>
  )
}

export function FrameLink({ to, children = "See all" }: { to: string; children?: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="group/link inline-flex shrink-0 items-center gap-0.5 rounded-full text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
      <CaretRightIcon className="size-3 transition-transform duration-200 group-hover/link:translate-x-0.5" />
    </Link>
  )
}

export function FrameWell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-well"
      className={cn(
        "min-w-0 flex-1 rounded-[22px] border border-well-border bg-well px-4 py-3 [corner-shape:squircle]",
        className
      )}
      {...props}
    />
  )
}

/** A compact metric tile: label in the rim, big number in the well. */
export function StatFrame({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <Frame className={className}>
      <div className="flex items-center justify-between gap-2 px-3 pt-1.5 pb-1.5 text-sm text-muted-foreground">
        <span className="truncate">{label}</span>
      </div>
      <FrameWell className="flex flex-col justify-center gap-0.5 py-3.5">
        <div className="text-2xl font-medium tracking-tight tabular-nums">{value}</div>
        {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
      </FrameWell>
    </Frame>
  )
}
