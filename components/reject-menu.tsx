import * as React from "react"
import { ClockIcon, ProhibitIcon, ThumbsDownIcon, XIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { isSnoozed, REJECT_REASON_LABEL, SNOOZE_DAYS, type RejectReason } from "@/lib/core/decide/learn"

// Rejecting a proposal asks why, in one click: the answer teaches the
// Savings ratings (see lib/core/decide/learn). "Not now" only snoozes.

const ITEMS: Array<{ reason: RejectReason; icon: typeof XIcon; hint: string }> = [
  { reason: "used", icon: ProhibitIcon, hint: "Rates cuts like this riskier" },
  { reason: "wrong", icon: ThumbsDownIcon, hint: "Rates cuts like this riskier" },
  { reason: "later", icon: ClockIcon, hint: `Suggested again in ${SNOOZE_DAYS} days` },
]

export function RejectMenu({ onReject, label = "Reject" }: { onReject: (reason?: RejectReason) => void; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={label}>
          <XIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Why reject it?</DropdownMenuLabel>
        {ITEMS.map(({ reason, icon: Icon, hint }) => (
          <DropdownMenuItem key={reason} onSelect={() => onReject(reason)}>
            <Icon />
            <span className="flex flex-col">
              {REJECT_REASON_LABEL[reason]}
              <span className="text-xs text-muted-foreground">{hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onReject()}>
          <XIcon />
          Just reject
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Back in 12d" on a rejected rule snoozed with "Not now". */
export function SnoozeNote({ rule }: { rule: { status: string; snoozedUntil?: string } }) {
  // Days left as of mount; a page that stays open for days can be a day off.
  const [now] = React.useState(() => Date.now())
  if (!isSnoozed(rule, now) || !rule.snoozedUntil) return null
  const days = Math.max(1, Math.ceil((new Date(rule.snoozedUntil).getTime() - now) / 86_400_000))
  return (
    <span className="text-xs text-muted-foreground" title={`Snoozed until ${new Date(rule.snoozedUntil).toLocaleDateString()}`}>
      Back in {days}d
    </span>
  )
}
