import * as React from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { rulesPath } from "@/app/paths"
import type { Assessment } from "@/lib/core/decide/risk"
import { useAppStore } from "@/lib/store/app-store"

// Autopilot: with it on, every open cut rated safe is proposed as soon as its
// evidence is in. Proposals still wait in Rules; nothing becomes active on its
// own. Each cut is tried once per mount, and a rejected one is never offered
// again (rankOpportunities hides it), so nothing loops.

export function useAutopilot<T extends { id: string; state: string; risk: Assessment }>(
  items: T[],
  loading: boolean,
  propose: (item: T) => Promise<boolean> | boolean
) {
  const on = useAppStore((state) => state.autopilot)
  const navigate = useNavigate()
  const tried = React.useRef(new Set<string>())

  React.useEffect(() => {
    // Ratings settle once every check is back; don't act on a partial picture.
    if (!on || loading) return
    const fresh = items.filter((item) => item.state === "open" && item.risk.level === "safe" && !tried.current.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) tried.current.add(item.id)
    void (async () => {
      let added = 0
      for (const item of fresh) if (await propose(item)) added += 1
      if (added) {
        toast.success(`Autopilot proposed ${added} safe ${added === 1 ? "cut" : "cuts"}`, {
          description: "They wait in Rules for review.",
          action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) },
        })
      }
    })()
  }, [on, loading, items, propose, navigate])
}
