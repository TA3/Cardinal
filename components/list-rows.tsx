import * as React from "react"
import { CaretDownIcon } from "@phosphor-icons/react"
import { motion } from "motion/react"
import { Link } from "react-router"

import { Expand } from "@/components/motion"
import { cn } from "@/lib/utils"

export interface ListRowProps {
  label: React.ReactNode
  value?: React.ReactNode
  percent?: number
  to?: string
  leading?: React.ReactNode
  mono?: boolean
  muted?: boolean
}

export function ListRow({ label, value, percent, to, leading, mono, muted }: ListRowProps) {
  const content = (
    <>
      {leading ?? <span className="size-1.5 shrink-0 rounded-full bg-brand/60" />}
      <span
        className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[13px]", muted && "text-muted-foreground")}
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      {value !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{value}</span> : null}
      {percent !== undefined ? (
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{percent < 1 ? "<1" : Math.round(percent)}%</span>
      ) : null}
    </>
  )
  const className = "-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-sm transition-colors"
  return to ? (
    <Link to={to} className={cn(className, "outline-none hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/50")}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  )
}

/** A list that shows `initial` rows and expands in place to show the rest. */
export function ExpandableList({ rows, initial = 5 }: { rows: ListRowProps[]; initial?: number }) {
  const [open, setOpen] = React.useState(false)
  const head = rows.slice(0, initial)
  const tail = rows.slice(initial)
  return (
    <div className={cn("relative flex flex-col", tail.length && "pb-3")}>
      {head.map((row, index) => (
        <div
          key={index}
          className={cn("transition-opacity duration-300", !open && tail.length && index === head.length - 1 && "opacity-45")}
        >
          <ListRow {...row} />
        </div>
      ))}
      {/* Rows bleed 8px each side for their hover fill; widen the clipping
          box by the same amount so revealed rows look like the first ones. */}
      <Expand open={open} className="-mx-2 px-2">
        <div className="flex flex-col">
          {tail.map((row, index) => (
            <ListRow key={index} {...row} />
          ))}
        </div>
      </Expand>
      {tail.length ? (
        <button
          type="button"
          aria-label={open ? "Show fewer" : "Show more"}
          onClick={() => setOpen((value) => !value)}
          className="absolute -bottom-6 left-1/2 flex h-6 -translate-x-1/2 items-center gap-1 rounded-full border border-frame-border bg-frame px-2.5 text-[11px] text-muted-foreground shadow-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ type: "spring", bounce: 0.3, duration: 0.4 }} className="flex">
            <CaretDownIcon className="size-3" />
          </motion.span>
          {open ? "Less" : `${tail.length} more`}
        </button>
      ) : null}
    </div>
  )
}
