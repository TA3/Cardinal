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
import {
  logSavingsRows,
  useLogOpportunities,
} from "@/features/logs/top-savings"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import {
  metricSavingsRows,
  useMetricOpportunities,
  useProposeOpportunity,
} from "@/features/overview/top-savings"
import { formatDelta } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import {
  RISK_LABEL,
  RISK_ORDER,
  type Assessment,
  type RiskLevel,
} from "@/lib/core/decide/risk"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import type { Snapshot } from "@/lib/core/snapshot"
import { useAppStore } from "@/lib/store/app-store"

// Savings: every cut Cardinal found, metrics and logs on one page, safest
// first. Each signal keeps its own unit (series, bytes/day); "Propose N safe"
// queues every cut rated safe for review in Rules in one click.

/** Safe first; within a level the incoming order (largest saving first) holds. */
function bySafety<T extends { risk: Assessment }>(items: T[]) {
  return [...items].sort(
    (a, b) =>
      RISK_ORDER.indexOf(a.risk.level) - RISK_ORDER.indexOf(b.risk.level)
  )
}

function countByRisk(items: Array<{ risk: Assessment; state: string }>) {
  const counts: Record<RiskLevel, number> = { safe: 0, review: 0, risky: 0 }
  for (const item of items)
    if (item.state === "open") counts[item.risk.level] += 1
  return counts
}

/** Reports open-item counts by risk to the page header, only when they change. */
function useReportCounts(
  items: Array<{ risk: Assessment; state: string }>,
  onCounts: (counts: Record<RiskLevel, number>) => void
) {
  const key = JSON.stringify(countByRisk(items))
  React.useEffect(
    () => onCounts(JSON.parse(key) as Record<RiskLevel, number>),
    [key, onCounts]
  )
}

/** Proposes every item quietly, then one toast for the lot. */
function useBulkPropose() {
  const navigate = useNavigate()
  return async <T,>(
    items: T[],
    propose: (item: T) => Promise<boolean> | boolean
  ) => {
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

function MetricsSavings({
  snapshot,
  onCounts,
}: {
  snapshot: Snapshot
  onCounts: (counts: Record<RiskLevel, number>) => void
}) {
  const { items, loading, impacts } = useMetricOpportunities(snapshot)
  const propose = useProposeOpportunity(snapshot, impacts)
  const bulk = useBulkPropose()
  const { format } = useCost()
  const sorted = React.useMemo(() => bySafety(items), [items])
  const safe = sorted.filter(
    (item) => item.state === "open" && item.risk.level === "safe"
  )
  const total = items
    .filter((item) => item.state === "open")
    .reduce((sum, item) => sum + item.savedSeries, 0)
  useReportCounts(items, onCounts)

  const needScan = items.filter(
    (item) => item.state === "open" && item.risk.missing === "dashboards"
  ).length

  return (
    <div className="flex flex-col gap-2">
      {needScan ? (
        <p className="px-1 text-xs text-muted-foreground">
          {needScan} {needScan === 1 ? "cut is" : "cuts are"} waiting on
          dashboard usage.{" "}
          <Link
            to={`${paths.settings}#grafana`}
            className="text-brand-ink hover:underline"
          >
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
          description:
            "No unused big metrics, ID-like labels or heavy histograms found.",
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

function LogsSavings({
  snapshot,
  onCounts,
}: {
  snapshot: LogsSnapshot
  onCounts: (counts: Record<RiskLevel, number>) => void
}) {
  const { items, loading } = useLogOpportunities(snapshot)
  const propose = useProposeLogRule()
  const bulk = useBulkPropose()
  const { format } = useBytesCost()
  const sorted = bySafety(items)
  const safe = sorted.filter(
    (item) => item.state === "open" && item.risk.level === "safe"
  )
  const total = items
    .filter((item) => item.state === "open")
    .reduce((sum, item) => sum + (item.savedBytesPerDay ?? 0), 0)
  useReportCounts(items, onCounts)

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
        description:
          "No noisy patterns, debug lines or runaway labels in the top services.",
        action: (
          <Button asChild variant="outline" size="sm">
            <Link to={paths.logVolume}>Open volume</Link>
          </Button>
        ),
      }}
    />
  )
}

function Connect() {
  const { openGrafanaConnect } = useShellActions()
  return (
    <Frame>
      <FrameHeader
        icon={PlugsConnectedIcon}
        title="Connect your data"
        meta="One step with Grafana"
      />
      <FrameWell className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          Point Cardinal at your Grafana and it finds the Prometheus and Loki
          data sources itself. Queries run from this tab; nothing is stored.
        </p>
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
  const parts = RISK_ORDER.filter((level) => counts[level] > 0).map(
    (level) => `${counts[level]} ${RISK_LABEL[level].toLowerCase()}`
  )
  return parts.length ? (
    <span className="tabular-nums">{parts.join(" · ")}</span>
  ) : null
}

const EMPTY_COUNTS: Record<RiskLevel, number> = { safe: 0, review: 0, risky: 0 }

export function InboxPage() {
  const snapshot = useAppStore((state) => state.snapshot)
  const logsSnapshot = useAppStore((state) => state.logsSnapshot)
  const hasLogs = useAppStore((state) =>
    Boolean(state.logsSettings.baseUrl.trim())
  )
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
        description="Every cut Cardinal found, safest first. Safe means nothing that was checked uses it; hover a rating for why."
      />
      <Stagger className="flex flex-col gap-4">
        {!snapshot && !logs ? (
          <Reveal>
            <Connect />
          </Reveal>
        ) : null}
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
      </Stagger>
    </Page>
  )
}
