import * as React from "react"
import { Link, useParams, useSearchParams } from "react-router"

import { logLabelPath, paths } from "@/app/paths"
import { CopyButton } from "@/components/code-block"
import { CostText } from "@/components/cost-text"
import { LogRuleToggle } from "@/components/log-rule-toggle"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { Badge } from "@/components/ui/badge"
import { Term } from "@/features/rules/term"
import { GroupLabelsCard, useGroupLabelStats } from "@/features/logs/stream-detail-labels"
import { GroupRulesCard, PatternsCard, SampleLinesCard, UsedByCard, VolumeByValueCard } from "@/features/logs/stream-detail-cards"
import { LogsSnapshotLine, patchParams } from "@/features/logs/streams-shared"
import { perDay, useStreamStats } from "@/features/logs/streams-queries"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes } from "@/lib/core/bytes"
import { groupNoun, LOGS_RANGE_LABEL } from "@/lib/core/logs/snapshot"
import type { LabelMatcher, LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"

// One stream group (a service, by default): the logs equivalent of the metric
// detail page. Labels and what dropping or moving each saves, volume by value,
// sample lines, top patterns, the rules that apply and where it is used.

function GroupDetail({ snapshot, group, by }: { snapshot: LogsSnapshot; group: string; by: string }) {
  const [params, setParams] = useSearchParams()
  const expanded = params.get("label")
  const matchers = React.useMemo<LabelMatcher[]>(() => [{ label: by, op: "=", value: group }], [by, group])
  const selector = React.useMemo<StreamSelector>(() => ({ matchers }), [matchers])
  const known = by === snapshot.groupLabel ? snapshot.groups.find((item) => item.value === group) : undefined
  const stats = useStreamStats(snapshot, matchers)
  const streams = known?.streams || stats.data?.streams
  const bytes = known?.bytes ?? stats.data?.bytes
  const share = bytes !== undefined && snapshot.totals.bytes > 0 ? (bytes / snapshot.totals.bytes) * 100 : undefined
  const day = bytes !== undefined ? perDay(bytes, snapshot) : undefined
  const labelStats = useGroupLabelStats(snapshot, by, group, streams)
  // Every param, like the metric page's link (the label that's open, a non-default grouping).
  const link = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}${params.size ? `?${params}` : ""}`

  const facts = [
    streams !== undefined ? (
      <span key="streams">
        {formatNumber(streams)} <Term id="logStream">{streams === 1 ? "stream" : "streams"}</Term>
      </span>
    ) : null,
    day !== undefined ? (
      <span key="day" title={`${formatBytes(bytes!)} in the last ${LOGS_RANGE_LABEL[snapshot.range]}. ${BYTES_NOTE}.`}>
        {formatBytes(day)}/day
      </span>
    ) : null,
    share !== undefined ? <span key="share">{share < 0.1 ? "<0.1" : share.toFixed(1)}% of volume</span> : null,
    stats.data?.entries ? <span key="lines">{formatNumber(stats.data.entries)} lines</span> : null,
    day !== undefined ? <CostText key="cost" bytes={day} per="day" className="text-sm" /> : null,
  ].filter(Boolean)

  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <Badge variant="outline">Stream group</Badge>
            <Badge variant="ghost" asChild>
              <Link to={logLabelPath(by)} title={`The ${by} label`}>
                <span className="font-mono">{by}</span>
              </Link>
            </Badge>
            <Badge variant="ghost" asChild>
              <Link to={`${paths.logStreams}${by === snapshot.groupLabel ? "" : `?by=${encodeURIComponent(by)}`}`}>All {groupNoun(by)}</Link>
            </Badge>
          </>
        }
        title={group}
        description={
          <span className="flex flex-col gap-1">
            {facts.length ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                {facts.map((fact, index) => (
                  <React.Fragment key={index}>
                    {index ? <span aria-hidden className="text-muted-foreground/50">·</span> : null}
                    {fact}
                  </React.Fragment>
                ))}
              </span>
            ) : stats.isPending ? (
              <span>Measuring…</span>
            ) : (
              <span>No volume for {by}={group} in the last {LOGS_RANGE_LABEL[snapshot.range]}.</span>
            )}
            <LogsSnapshotLine snapshot={snapshot} />
          </span>
        }
        actions={
          <>
            <CopyButton text={link} label="Copy link" className="h-8 px-3" />
            <LogRuleToggle kind="drop_lines" selector={selector} size="lg" />
            <LogRuleToggle kind="sample" selector={selector} size="lg" />
            <LogRuleToggle kind="drop_streams" selector={selector} size="lg" hint={day !== undefined ? `−${formatBytes(day)}/day` : undefined} />
            <LogRuleToggle kind="keep" selector={selector} size="lg" />
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <GroupLabelsCard
            snapshot={snapshot}
            by={by}
            group={group}
            knownStreams={streams}
            expanded={expanded}
            onExpand={(label) => setParams((current) => patchParams(current, { label }), { replace: true })}
          />
          <PatternsCard snapshot={snapshot} by={by} group={group} />
          <SampleLinesCard selector={selector} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <GroupRulesCard snapshot={snapshot} selector={selector} />
          <VolumeByValueCard snapshot={snapshot} selector={selector} labels={labelStats} />
          <UsedByCard selector={selector} />
        </div>
      </div>
    </Page>
  )
}

export function StreamDetailPage() {
  const { group = "" } = useParams()
  const [params] = useSearchParams()
  return (
    <RequireLogsSnapshot>
      {(snapshot) => {
        const by = params.get("by") || snapshot.groupLabel
        return <GroupDetail key={`${by}=${group}`} snapshot={snapshot} group={group} by={by} />
      }}
    </RequireLogsSnapshot>
  )
}
