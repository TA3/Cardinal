import * as React from "react"
import { ArrowSquareOutIcon, CaretDownIcon, FingerprintIcon, MagnifyingGlassIcon, ShieldCheckIcon, TerminalIcon } from "@phosphor-icons/react"
import { Link } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Expand } from "@/components/motion"
import { ShareBar } from "@/components/share-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { PatternsTable, patternTableRows } from "@/features/logs/pattern-table"
import { usePatterns, type PatternRange } from "@/features/logs/patterns-data"
import { perDay, useLabelVolume, useSampleLines } from "@/features/logs/streams-queries"
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

// ---- sample lines ----

export function SampleLinesCard({ selector }: { selector: StreamSelector }) {
  const [open, setOpen] = React.useState(false)
  const { data, isPending, error, isFetching } = useSampleLines(selector.matchers, open)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-muted-foreground" />
          Sample lines
          <InfoTip label="About this card">The newest 20 lines from the last hour, read only when you open this.</InfoTip>
        </CardTitle>
        <CardAction>
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open && isFetching ? <Spinner data-icon="inline-start" /> : <CaretDownIcon data-icon="inline-start" className={cn("transition-transform", open && "rotate-180")} />}
            {open ? "Hide" : "Show"}
          </Button>
        </CardAction>
      </CardHeader>
      <Expand open={open}>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-32" />
          ) : error ? (
            <p className="text-xs text-destructive">{errorText(error)}</p>
          ) : !data?.length ? (
            <p className="text-sm text-muted-foreground">No lines in the last hour.</p>
          ) : (
            <ol className="max-h-96 overflow-auto rounded-lg border bg-background/60 font-mono text-[11px] leading-relaxed">
              {data.map((line, index) => (
                <li key={`${line.t}-${index}`} className="flex gap-3 border-b px-2.5 py-1 last:border-b-0">
                  <time className="shrink-0 text-muted-foreground tabular-nums" dateTime={new Date(line.t).toISOString()}>
                    {new Date(line.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                  <span className="min-w-0 break-all whitespace-pre-wrap">{line.line}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Expand>
    </Card>
  )
}

// ---- patterns ----

/** The group's top patterns, in the same table (and with the same toggles) as the Patterns page. */
export function PatternsCard({ snapshot, by, group }: { snapshot: LogsSnapshot; by: string; group: string }) {
  const range: PatternRange = "3h"
  const { data, isPending, error } = usePatterns(by, group, range)
  const { rows } = React.useMemo(() => patternTableRows(snapshot, by, group, data), [snapshot, by, group, data])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FingerprintIcon className="size-4 text-muted-foreground" />
          Top <Term id="logPattern">patterns</Term>
          <InfoTip label="About this card">
            Line shapes Loki detected over the last {range}, most frequent first. Drop, sample or protect a pattern with a line regex built from it.
          </InfoTip>
        </CardTitle>
        <CardAction>
          <Button asChild size="xs" variant="ghost">
            <Link to={`${paths.logPatterns}?service=${encodeURIComponent(group)}`}>All patterns</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't read patterns</AlertTitle>
            <AlertDescription>{authErrorText(error, "logs")}</AlertDescription>
          </Alert>
        ) : data?.patterns === null ? (
          <EmptyState
            compact
            icon={FingerprintIcon}
            title="Your Loki doesn't run the pattern ingester"
            description="Patterns need Loki 3.0+ with pattern_ingester enabled (Grafana Cloud has it). Use Drop lines… with a regex instead."
          />
        ) : rows.length === 0 ? (
          <EmptyState compact icon={MagnifyingGlassIcon} title="No patterns yet" description={`Loki detected no patterns for these streams in the last ${range}.`} />
        ) : (
          <PatternsTable rows={rows} groupLabel={by} range={range} showService={false} showOpen={false} initial={8} />
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
