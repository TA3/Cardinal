import * as React from "react"
import { ArrowSquareOutIcon, ShieldCheckIcon } from "@phosphor-icons/react"
import { Link } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { ShareBar } from "@/components/share-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/info-tip"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { selectorText } from "@/features/logs/log-rule-gate"
import { perDay, useLabelVolume } from "@/features/logs/streams-queries"
import { EvidenceList } from "@/features/rules/drop-gate"
import { LogRuleActions, LogRuleDescription, LogRuleImpactCell, LogRuleOriginBadge } from "@/features/rules/log-rule-parts"
import { useLogUsageSummary } from "@/features/rules/log-usage"
import { Term } from "@/features/rules/term"
import { cancelLogqlScan, startLogqlScan, useLogqlUsage } from "@/features/usage/logql-scan"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { grafanaUrl } from "@/lib/core/grafana-usage"
import type { GroupLabelStat } from "@/lib/core/logs/label-advice"
import { partitionLogUsage, type LogRuleTarget } from "@/lib/core/logs/logql-usage"
import { logRuleProtectedBy, logRuleShadowedBy } from "@/lib/core/logs/rules"
import { selectorsDisjoint } from "@/lib/core/logs/selector"
import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const errorText = (error: Error) => authErrorText(error, "logs")

// ---- volume by label value ----

const PREFERRED_SPLIT = ["detected_level", "level", "container", "pod", "namespace", "instance"]

export function VolumeByValueCard({ snapshot, selector, labels }: { snapshot: LogsSnapshot; selector: StreamSelector; labels: GroupLabelStat[] | null }) {
  const options = React.useMemo(() => (labels ?? []).filter((stat) => stat.distinctValues > 1).map((stat) => stat.label), [labels])
  const fallback = PREFERRED_SPLIT.find((label) => options.includes(label)) ?? options[0] ?? null
  const [picked, setPicked] = React.useState<string | null>(null)
  const label = picked && options.includes(picked) ? picked : fallback
  const { data, isPending, error } = useLabelVolume(snapshot, selector.matchers, label, label !== null, 10)
  const total = data?.reduce((sum, row) => sum + row.bytes, 0) ?? 0
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          <Term id="logVolume">Volume</Term> by value
          <InfoTip label="About this card">Bytes per day for each value of one label in this group.</InfoTip>
        </CardTitle>
        {options.length ? (
          <CardAction>
            <Select value={label ?? undefined} onValueChange={setPicked}>
              <SelectTrigger size="sm" className="max-w-36" aria-label="Label to split volume by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {options.map((option) => (
                    <SelectItem key={option} value={option}>
                      <span className="font-mono text-xs">{option}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {labels === null || (label !== null && isPending) ? (
          <Skeleton className="h-24" />
        ) : label === null ? (
          <p className="text-sm text-muted-foreground">Every label here has a single value.</p>
        ) : error ? (
          <p className="text-xs text-destructive">{errorText(error)}</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">No volume per {label}.</p>
        ) : (
          data.map((row) => (
            <div key={row.value} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-mono text-xs" title={row.value}>
                  {row.value}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(perDay(row.bytes, snapshot))}/day</span>
              </div>
              <ShareBar percent={total > 0 ? (row.bytes / total) * 100 : 0} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ---- rules ----

/** Rules that apply to these streams (broader ones included), with the Rules page's parts, like the metric page's Rules card. */
export function GroupRulesCard({ snapshot, selector }: { snapshot: LogsSnapshot; selector: StreamSelector }) {
  const logRules = useAppStore((state) => state.logRules)
  const rules = logRules.filter((rule) => rule.status !== "rejected" && (rule.selector.matchers.length === 0 || !selectorsDisjoint(rule.selector, selector)))
  const active = logRules.filter((rule) => rule.status === "active")
  const rangeDays = LOGS_RANGE_SECONDS[snapshot.range] / 86400
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          Rules
          <InfoTip label="About this card">Log rules that apply to these streams, including broader ones.</InfoTip>
        </CardTitle>
        <CardAction>
          <Button asChild size="xs" variant="ghost">
            <Link to={paths.rules}>All rules</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <EmptyState compact icon={ShieldCheckIcon} title="No rules yet" />
        ) : (
          <ItemGroup className="gap-2">
            {rules.map((rule) => (
              <Item key={rule.id} variant="outline" size="sm" className="items-start">
                <ItemContent className="min-w-0 gap-2">
                  <LogRuleDescription
                    rule={rule}
                    supersededBy={rule.status === "active" ? logRuleShadowedBy(rule, active) : undefined}
                    protectedBy={rule.status === "active" ? logRuleProtectedBy(rule, active) : undefined}
                  />
                  <div className="flex flex-wrap items-center gap-1">
                    <LogRuleOriginBadge rule={rule} />
                    {rule.status === "proposed" ? <Badge variant="secondary">Proposed</Badge> : null}
                  </div>
                  {rule.rationale ? <ItemDescription className="line-clamp-3">{rule.rationale}</ItemDescription> : null}
                </ItemContent>
                <div className="flex flex-col items-end gap-2">
                  <LogRuleImpactCell rule={rule} rangeDays={rangeDays} totalBytes={snapshot.totals.bytes} />
                  <LogRuleActions rule={rule} />
                </div>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

// ---- used by ----

export function LogqlScanControl({ className }: { className?: string }) {
  const usage = useLogqlUsage()
  if (!usage.grafanaConfigured) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        <Link to={paths.settings} className="underline-offset-2 hover:text-foreground hover:underline">
          Connect Grafana in Settings
        </Link>{" "}
        to check dashboards for LogQL that reads these streams.
      </p>
    )
  }
  if (usage.progress) {
    const percent = usage.progress.total ? Math.round((usage.progress.done / usage.progress.total) * 100) : null
    return (
      <div className={cn("flex flex-col gap-1.5 text-xs text-muted-foreground", className)} role="status">
        <div className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          <span className="flex-1">
            Scanning {usage.grafanaHost} for LogQL
            {usage.progress.total ? ` · ${usage.progress.done} / ${usage.progress.total}` : "…"}
          </span>
          <Button size="xs" variant="ghost" onClick={cancelLogqlScan}>
            Cancel
          </Button>
        </div>
        {percent !== null ? <Progress value={percent} className="h-1" aria-label="LogQL scan progress" /> : null}
      </div>
    )
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground", className)}>
      <Button
        size="xs"
        variant="outline"
        title={usage.grafanaHost ? `Reads every dashboard on ${usage.grafanaHost}, four at a time` : undefined}
        onClick={() =>
          void startLogqlScan().then(
            (index) => toast.success(`Scanned ${index.dashboardsScanned} dashboards`, { description: `${formatNumber(index.queries.length)} LogQL queries found.` }),
            (error: unknown) => {
              if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("LogQL scan failed", { description: error instanceof Error ? error.message : String(error) })
            }
          )
        }
      >
        {usage.index ? "Rescan dashboards" : "Scan dashboards for LogQL"}
      </Button>
      {usage.error ? <span className="text-destructive">{usage.error}</span> : null}
    </div>
  )
}

export function UsedByCard({ selector }: { selector: StreamSelector }) {
  const target = React.useMemo<LogRuleTarget>(() => ({ kind: "drop_streams", selector }), [selector])
  const { summary, rules, usage, isPending } = useLogUsageSummary(target)
  const ruleReads = React.useMemo(() => (rules.rules ? partitionLogUsage(target, rules.rules).reads : []), [rules.rules, target])
  const panelReads = React.useMemo(() => (usage.index ? partitionLogUsage(target, usage.index.queries).reads : []), [usage.index, target])
  const grafanaBase = usage.index?.baseUrl
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          Used by
          <InfoTip label="About this card">Loki alerting and recording rules and Grafana dashboard panels whose LogQL reads {selectorText(selector)}.</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ruleReads.length || panelReads.length ? (
          <ItemGroup className="gap-1">
            {ruleReads.slice(0, 8).map((ref, index) => (
              <Item key={`rule:${ref.where}/${ref.name}/${index}`} size="xs" variant="muted">
                <ItemContent>
                  <ItemTitle className="font-mono text-xs break-all">{ref.name}</ItemTitle>
                  <ItemDescription>
                    Loki {ref.kind} rule · {ref.where}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
            {panelReads.slice(0, 8).map((ref, index) => (
              <Item key={`panel:${ref.url}/${ref.name}/${index}`} size="xs" variant="muted" asChild>
                <a href={grafanaBase && ref.url ? grafanaUrl(grafanaBase, ref.url) : undefined} target="_blank" rel="noreferrer">
                  <ItemContent>
                    <ItemTitle className="text-xs">
                      {ref.name}
                      <ArrowSquareOutIcon className="size-3 text-muted-foreground" />
                    </ItemTitle>
                    <ItemDescription>
                      {ref.kind === "variable" ? "Variable" : "Panel"} · {ref.where}
                    </ItemDescription>
                  </ItemContent>
                </a>
              </Item>
            ))}
          </ItemGroup>
        ) : null}
        <EvidenceList summary={summary} pending={isPending} compact />
        <LogqlScanControl />
      </CardContent>
    </Card>
  )
}
