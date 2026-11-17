import * as React from "react"
import { PlugsConnectedIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths, rulesPath } from "@/app/paths"
import { useBytesCost } from "@/components/cost-text"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { SavingsList } from "@/components/savings-list"
import { Button } from "@/components/ui/button"
import { useAutopilot } from "@/features/inbox/autopilot"
import { logSavingsRows, useLogOpportunities } from "@/features/logs/top-savings"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { ConnectChooser } from "@/features/settings/connect-chooser"
import { formatBytes } from "@/lib/core/bytes"
import { orderForReview, type Assessment, type RiskLevel } from "@/lib/core/decide/risk"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// Pieces of the Plan page: the logs cuts (bytes/day, proposed for review in
// Rules), the connect card and the note on what the ratings learn from.

function countByRisk(items: Array<{ risk: Assessment; state: string }>) {
  const counts: Record<RiskLevel, number> = { safe: 0, review: 0, risky: 0 }
  for (const item of items) if (item.state === "open") counts[item.risk.level] += 1
  return counts
}

/** Reports open-item counts by risk to the page header, only when they change. */
function useReportCounts(items: Array<{ risk: Assessment; state: string }>, onCounts: (counts: Record<RiskLevel, number>) => void) {
  const key = JSON.stringify(countByRisk(items))
  React.useEffect(() => onCounts(JSON.parse(key) as Record<RiskLevel, number>), [key, onCounts])
}

/** Proposes every item quietly, then one toast for the lot. */
function useBulkPropose() {
  const navigate = useNavigate()
  return async <T,>(items: T[], propose: (item: T) => Promise<boolean> | boolean) => {
    let added = 0
    for (const item of items) if (await propose(item)) added += 1
    if (added) {
      toast.success(`Proposed ${added} safe ${added === 1 ? "cut" : "cuts"}`, {
        description: "They wait in Rules for review.",
        action: {
          label: "Review",
          onClick: () => navigate(rulesPath("proposed")),
        },
      })
    } else {
      toast.info("Rules already cover these")
    }
  }
}

export function LogsSavings({ snapshot, onCounts }: { snapshot: LogsSnapshot; onCounts: (counts: Record<RiskLevel, number>) => void }) {
  const { items, loading } = useLogOpportunities(snapshot)
  const propose = useProposeLogRule()
  const bulk = useBulkPropose()
  const { format } = useBytesCost()
  const sorted = orderForReview(items)
  const safe = sorted.filter((item) => item.state === "open" && item.risk.level === "safe")
  const total = items.filter((item) => item.state === "open").reduce((sum, item) => sum + (item.savedBytesPerDay ?? 0), 0)
  useReportCounts(items, onCounts)
  useAutopilot(items, loading, (item) => propose(item.rule, { quiet: true }))

  return (
    <SavingsList
      title="Logs"
      rows={logSavingsRows(sorted, propose, format)}
      loading={loading}
      initial={8}
      total={total > 0 ? `up to −${formatBytes(total)}/day` : undefined}
      proposeSafe={{
        count: safe.length,
        run: () => bulk(safe, (item) => propose(item.rule, { quiet: true })),
      }}
      empty={{
        title: "Nothing obvious to cut",
        description: snapshot.imported
          ? "Logs cuts come from repeated lines and labels, which need a live connection. You can still drop or sample a service from Streams."
          : "No noisy patterns, debug lines or runaway labels in the top services.",
        action: (
          <Button asChild variant="outline" size="sm">
            {snapshot.imported ? <Link to={paths.logStreams}>Open streams</Link> : <Link to={paths.logVolume}>Open volume</Link>}
          </Button>
        ),
      }}
    />
  )
}

export function Connect() {
  const navigate = useNavigate()
  return (
    <Frame>
      <FrameHeader icon={PlugsConnectedIcon} title="Connect your data" meta="Queries run from this tab; nothing is stored" />
      <FrameWell>
        <ConnectChooser signal="metrics" onUrl={() => navigate(paths.overview, { state: { connect: "url" } })} />
      </FrameWell>
    </Frame>
  )
}

/** How many decisions the ratings learn from, and a way to forget them. */
export function Learning() {
  const decisions = useAppStore((state) => state.decisions)
  const forget = useAppStore((state) => state.forgetDecisions)
  const count = decisions.filter((decision) => decision.reason !== "later").length
  if (!count) {
    return (
      <p className="px-1 text-xs text-muted-foreground">Ratings adapt as you add cuts and reject proposals. Nothing leaves this browser.</p>
    )
  }
  return (
    <p className="px-1 text-xs text-muted-foreground">
      Ratings also learn from your last {count} {count === 1 ? "decision" : "decisions"}, kept in this browser.{" "}
      <button
        type="button"
        onClick={() => {
          forget()
          toast.success("Forgot your decisions", { description: "Ratings are back to the built-in checks." })
        }}
        className="rounded-sm text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Forget them
      </button>
    </p>
  )
}
