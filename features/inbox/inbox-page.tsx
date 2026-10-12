import * as React from "react"
import { PlugsConnectedIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths, rulesPath } from "@/app/paths"
import { useShellActions } from "@/app/shell/shell-actions"
import { useBytesCost, useCost } from "@/components/cost-text"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Reveal, Stagger } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { SavingsList } from "@/components/savings-list"
import { Button } from "@/components/ui/button"
import { useAutopilot } from "@/features/inbox/autopilot"
import { SetupChecklist } from "@/features/inbox/setup-checklist"
import { logSavingsRows, useLogOpportunities } from "@/features/logs/top-savings"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { metricSavingsRows, useMetricOpportunities, useProposeOpportunity } from "@/features/overview/top-savings"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { orderForReview, RISK_LABEL, RISK_ORDER, type Assessment, type RiskLevel } from "@/lib/core/decide/risk"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import type { Snapshot } from "@/lib/core/snapshot"
import { useAppStore } from "@/lib/store/app-store"

// Savings: every cut Cardinal found, metrics and logs on one page, safest
// first. Each signal keeps its own unit (series, bytes/day); "Propose N safe"
// queues every cut rated safe for review in Rules in one click.

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

function MetricsSavings({ snapshot, onCounts }: { snapshot: Snapshot; onCounts: (counts: Record<RiskLevel, number>) => void }) {
  const { items, loading, impacts } = useMetricOpportunities(snapshot)
  const propose = useProposeOpportunity(snapshot, impacts)
  const bulk = useBulkPropose()
  const { format } = useCost()
  const sorted = React.useMemo(() => orderForReview(items), [items])
  const safe = sorted.filter((item) => item.state === "open" && item.risk.level === "safe")
  const total = items.filter((item) => item.state === "open").reduce((sum, item) => sum + item.savedSeries, 0)
  useReportCounts(items, onCounts)
  useAutopilot(items, loading, (item) => propose(item, { quiet: true }))

  const needScan = items.filter((item) => item.state === "open" && item.risk.level !== "safe" && item.risk.missing === "dashboards").length

  return (
    <div className="flex flex-col gap-2">
      {needScan ? (
        <p className="px-1 text-xs text-muted-foreground">
          {needScan} {needScan === 1 ? "cut is" : "cuts are"} waiting on dashboard usage.{" "}
          <Link to={`${paths.settings}#grafana`} className="text-brand-ink hover:underline">
            Scan your Grafana
          </Link>{" "}
          and unused ones turn safe.
        </p>
      ) : null}
      <SavingsList
        title="Metrics"
        rows={metricSavingsRows(sorted, propose, format)}
        loading={loading}
        initial={8}
        total={total > 0 ? `up to ${formatDelta(-total)} series` : undefined}
        proposeSafe={{
          count: safe.length,
          run: () => bulk(safe, (item) => propose(item, { quiet: true })),
        }}
        empty={{
          title: "Nothing obvious to cut",
          description: "No unused big metrics, ID-like labels or heavy histograms found.",
          action: (
            <Button asChild variant="outline" size="sm">
              <Link to={paths.explore}>Explore metrics</Link>
            </Button>
          ),
        }}
      />
    </div>
  )
}

function LogsSavings({ snapshot, onCounts }: { snapshot: LogsSnapshot; onCounts: (counts: Record<RiskLevel, number>) => void }) {
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
        description: "No noisy patterns, debug lines or runaway labels in the top services.",
        action: (
          <Button asChild variant="outline" size="sm">
            <Link to={paths.logVolume}>Open volume</Link>
          </Button>
        ),
      }}
    />
  )
}

const HOW_IT_WORKS = [
  { title: "Connect", text: "Grafana, Prometheus or Loki. No agent to install." },
  { title: "Review cuts", text: "Each one is rated safe, review or risky, with why." },
  { title: "Apply", text: "Export relabel or Alloy config, or apply on Grafana Cloud." },
]

function Connect() {
  const { openGrafanaConnect } = useShellActions()
  return (
    <Frame>
      <FrameHeader icon={PlugsConnectedIcon} title="Connect your data" meta="One step with Grafana" />
      <FrameWell className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>Point Cardinal at your Grafana and it finds the Prometheus and Loki data sources itself. Queries run from this tab; nothing is stored.</p>
        <ol className="grid gap-2 sm:grid-cols-3">
          {HOW_IT_WORKS.map((step, index) => (
            <li key={step.title} className="flex gap-2 rounded-xl border border-well-border bg-background/40 px-3 py-2">
              <span className="font-mono text-xs text-brand-ink tabular-nums">{index + 1}</span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{step.title}</span>
                <span className="text-xs">{step.text}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={openGrafanaConnect}>
            <PlugsConnectedIcon data-icon="inline-start" />
            Connect Grafana
          </Button>
          <Button asChild variant="outline">
            <Link to={paths.overview}>Prometheus directly</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to={paths.logs}>Loki directly</Link>
          </Button>
        </div>
      </FrameWell>
    </Frame>
  )
}

/** "3 safe · 5 review · 1 risky" across both signals. */
function RiskSummary({ counts }: { counts: Record<RiskLevel, number> }) {
  const parts = RISK_ORDER.filter((level) => counts[level] > 0).map((level) => `${counts[level]} ${RISK_LABEL[level].toLowerCase()}`)
  return parts.length ? <span className="tabular-nums">{parts.join(" · ")}</span> : null
}

/** How many decisions the ratings learn from, and a way to forget them. */
function Learning() {
  const decisions = useAppStore((state) => state.decisions)
  const forget = useAppStore((state) => state.forgetDecisions)
  const count = decisions.filter((decision) => decision.reason !== "later").length
  if (!count) {
    return (
      <p className="px-1 text-xs text-muted-foreground">Ratings adapt as you accept and reject proposals in Rules. Nothing leaves this browser.</p>
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

const EMPTY_COUNTS: Record<RiskLevel, number> = { safe: 0, review: 0, risky: 0 }

export function InboxPage() {
  const snapshot = useAppStore((state) => state.snapshot)
  const logsSnapshot = useAppStore((state) => state.logsSnapshot)
  const hasLogs = useAppStore((state) => Boolean(state.logsSettings.baseUrl.trim()))
  const logs = hasLogs ? logsSnapshot : null
  const [metricCounts, setMetricCounts] = React.useState(EMPTY_COUNTS)
  const [logCounts, setLogCounts] = React.useState(EMPTY_COUNTS)
  const counts = {
    safe: metricCounts.safe + logCounts.safe,
    review: metricCounts.review + logCounts.review,
    risky: metricCounts.risky + logCounts.risky,
  }

  return (
    <Page>
      <PageHeader
        title="Savings"
        status={<RiskSummary counts={counts} />}
        description={
          snapshot || logs
            ? "Every cut Cardinal found, safest first. Safe means nothing that was checked uses it; hover a rating for why."
            : "Find the metrics, labels and log lines you pay for but don't use, and cut them safely."
        }
      />
      <Stagger className="flex flex-col gap-4">
        {!snapshot && !logs ? (
          <Reveal>
            <Connect />
          </Reveal>
        ) : null}
        {/* Renders nothing (no gap) once setup is done or dismissed. */}
        {snapshot || logs ? <SetupChecklist /> : null}
        {snapshot ? (
          <Reveal>
            <MetricsSavings snapshot={snapshot} onCounts={setMetricCounts} />
          </Reveal>
        ) : null}
        {logs ? (
          <Reveal>
            <LogsSavings snapshot={logs} onCounts={setLogCounts} />
          </Reveal>
        ) : null}
        {snapshot || logs ? (
          <Reveal>
            <Learning />
          </Reveal>
        ) : null}
      </Stagger>
    </Page>
  )
}
