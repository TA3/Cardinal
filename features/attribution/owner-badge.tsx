import { Link } from "react-router"

import { paths } from "@/app/paths"
import type { JobOwner } from "@/lib/core/owner-rules"
import { cn } from "@/lib/utils"

/** An owner's colour as a small dot; Unattributed is a dashed ring. */
export function OwnerDot({ color, unattributed = false, className }: { color?: string; unattributed?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        unattributed ? "border border-dashed border-muted-foreground/70" : !color && "bg-muted-foreground/60",
        className
      )}
      style={!unattributed && color ? { backgroundColor: color } : undefined}
    />
  )
}

function ownersTitle(owners: JobOwner[]) {
  const total = owners.reduce((sum, owner) => sum + owner.series, 0)
  const shown = owners.slice(0, 6).map((owner) => `${owner.name}: ${total > 0 ? Math.round((owner.series / total) * 100) : 0}%`)
  return owners.length > shown.length ? `${shown.join(", ")}, +${owners.length - shown.length} more` : shown.join(", ")
}

/**
 * The owner of most of a job's series, with "+N" when others own part of it.
 * Rows pass `hideUnattributed` to stay quiet; headers show Unattributed as a nudge.
 */
export function OwnerBadge({
  owners,
  hideUnattributed = false,
  className,
}: {
  owners: JobOwner[] | undefined
  hideUnattributed?: boolean
  className?: string
}) {
  if (!owners?.length) return null
  const [primary] = owners
  if (primary.unattributed && hideUnattributed) return null
  const others = owners.length - 1
  return (
    <Link
      to={paths.attribution}
      title={`Attributed to ${ownersTitle(owners)}`}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-frame-border bg-frame px-2 text-xs font-normal whitespace-nowrap text-muted-foreground no-underline outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        className
      )}
    >
      <OwnerDot color={primary.color} unattributed={primary.unattributed} />
      <span className={cn("truncate", !primary.unattributed && "text-foreground")}>{primary.name}</span>
      {others > 0 ? <span className="tabular-nums">+{others}</span> : null}
    </Link>
  )
}
