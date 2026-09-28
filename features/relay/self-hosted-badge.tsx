import { HardDrivesIcon } from "@phosphor-icons/react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRelayStore } from "@/lib/store/relay-store"

/** Marks a page served by a self-hosted `cardinal` server. */
export function SelfHostedBadge() {
  const server = useRelayStore((state) => state.server)
  if (!server) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-frame-border bg-frame px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-md:hidden"
        >
          <HardDrivesIcon className="size-3.5" />
          Self-hosted
        </span>
      </TooltipTrigger>
      <TooltipContent>Cardinal server {server.version}: its proxy reaches private hosts. Agent sessions need the hosted app.</TooltipContent>
    </Tooltip>
  )
}
