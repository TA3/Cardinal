import * as React from "react"

import { cn } from "@/lib/utils"

export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex w-full flex-col gap-4", className)} {...props} />
  )
}

export function PageHeader({
  title,
  status,
  description,
  actions,
  eyebrow,
}: {
  title: React.ReactNode
  /** Inline status next to the title, e.g. a live count. */
  status?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  eyebrow?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 pb-2 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? (
          <div className="flex flex-wrap items-center gap-2">{eyebrow}</div>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="truncate text-xl font-medium tracking-tight">
            {title}
          </h1>
          {status ? (
            <div className="flex items-center gap-1.5 text-sm font-medium text-brand-ink">
              {status}
            </div>
          ) : null}
        </div>
        {description ? (
          <div className="max-w-2xl text-sm text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
