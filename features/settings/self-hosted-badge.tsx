import { HardDrivesIcon, PlugsConnectedIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths } from "@/app/paths"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { proxyServerOrigin } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"
import { useServerStore } from "@/lib/store/server-store"

const PILL =
  "flex h-6 shrink-0 items-center gap-1 rounded-full border border-frame-border bg-frame px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-md:hidden"

/** Marks a page served by the user's own `cardinal` server, or one that uses it as its proxy. */
export function SelfHostedBadge() {
  const server = useServerStore((state) => state.server)
  const proxyServer = useAppStore((state) => state.proxyServer)
  if (server) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className={PILL}>
            <HardDrivesIcon className="size-3.5" />
            Self-hosted
          </span>
        </TooltipTrigger>
        <TooltipContent>Cardinal server {server.version}: its proxy reaches private hosts. Agent sessions need the hosted app.</TooltipContent>
      </Tooltip>
    )
  }
  const origin = proxyServerOrigin(proxyServer)
  if (!origin) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to={`${paths.settings}#proxy`} className={`${PILL} hover:text-foreground`}>
          <PlugsConnectedIcon className="size-3.5" />
          Via {new URL(origin).host}
        </Link>
      </TooltipTrigger>
      <TooltipContent>Proxy mode goes through your Cardinal server at {origin}. Cardinal's hosted servers never see those requests.</TooltipContent>
    </Tooltip>
  )
}
