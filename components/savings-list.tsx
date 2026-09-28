import * as React from "react"
import { CheckIcon, LightningIcon, PlusIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { rulesPath } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// "Top savings", shared by the metrics and logs overviews: one row per
// opportunity (what, how much, why in one word, Propose).

export interface SavingsRowProps {
  id: string
  reason: string
  title: React.ReactNode
  /** Plain title for the tooltip and the button's label. */
  titleText: string
  detail?: React.ReactNode
  to?: string
  saving: React.ReactNode
  cost?: React.ReactNode
  state: "open" | "proposed"
  onPropose: () => void | Promise<void>
}

function SavingsRow({ reason, title, titleText, detail, to, saving, cost, state, onPropose }: SavingsRowProps) {
  const [pending, setPending] = React.useState(false)
  const propose = async () => {
    setPending(true)
    try {
      await onPropose()
    } finally {
      setPending(false)
    }
  }
  const name = (
    <span className="min-w-0 truncate font-mono text-[13px]" title={titleText}>
      {title}
    </span>
  )
  return (
    <li data-slot="savings-row" className="-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-background/70">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {to ? (
            <Link to={to} className="flex min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
              {name}
            </Link>
          ) : (
            name
          )}
          {detail ? <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground md:inline">{detail}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground">
            {reason}
          </Badge>
          <span className="flex items-baseline gap-1.5 tabular-nums sm:w-36 sm:justify-end">
            <span className="text-sm font-medium">{saving}</span>
            {cost ? <span className="text-xs text-muted-foreground">{cost}</span> : null}
          </span>
        </div>
      </div>
      {state === "proposed" ? (
        <Button asChild size="xs" variant="ghost" className="w-24 shrink-0 text-muted-foreground">
          <Link to={rulesPath("proposed")}>
            <CheckIcon data-icon="inline-start" />
            Proposed
          </Link>
        </Button>
      ) : (
        <Button size="xs" variant="outline" className="w-24 shrink-0" disabled={pending} onClick={() => void propose()} aria-label={`Propose: ${titleText}`}>
          {pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
          Propose
        </Button>
      )}
    </li>
  )
}

/** The Top savings frame: the first `initial` rows, "See all" for the rest. */
export function SavingsList({
  rows,
  loading,
  total,
  initial = 6,
  empty,
  className,
}: {
  rows: SavingsRowProps[]
  /** Still gathering evidence: rows may grow. */
  loading: boolean
  /** Header meta, e.g. the total they'd save. */
  total?: React.ReactNode
  initial?: number
  empty: { title: string; description?: React.ReactNode; action?: React.ReactNode }
  className?: string
}) {
  const [all, setAll] = React.useState(false)
  const shown = all ? rows : rows.slice(0, initial)
  return (
    <Frame className={cn("h-full", className)}>
      <FrameHeader
        icon={LightningIcon}
        title="Top savings"
        meta={
          <span className="inline-flex items-center gap-1.5">
            {total}
            {loading ? <Spinner className="size-3" aria-label="Checking for more" /> : null}
          </span>
        }
        action={
          rows.length > initial ? (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="shrink-0 rounded-full text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {all ? "Show fewer" : `See all ${rows.length}`}
            </button>
          ) : undefined
        }
      />
      <FrameWell className="py-2">
        {rows.length ? (
          <ul className="flex flex-col">
            {shown.map((row) => (
              <SavingsRow key={row.id} {...row} />
            ))}
          </ul>
        ) : loading ? (
          <div className="flex flex-col gap-2 py-1.5">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-7" />
            ))}
          </div>
        ) : (
          <EmptyState compact icon={LightningIcon} title={empty.title} description={empty.description}>
            {empty.action}
          </EmptyState>
        )}
      </FrameWell>
    </Frame>
  )
}
