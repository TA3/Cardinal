import * as React from "react"
import { FingerprintIcon, LockSimpleIcon, PlusIcon, ShieldCheckIcon, SparkleIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths, rulesPath } from "@/app/paths"
import { CostText } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Term } from "@/features/rules/term"
import { connectionKey, LOGS_META, useConnection } from "@/hooks/use-cardinality"
import { formatBytes } from "@/lib/core/bytes"
import { exemptionProblem, exemptionToKeepRule, planExemptions, recommendationRows, recommendationToLogRule, type RecommendationRow } from "@/lib/core/logs/adaptive-apply"
import { compileAdaptiveLogs } from "@/lib/core/logs/compile/adaptive-logs"
import { createLogRule, logRuleKey } from "@/lib/core/logs/rules"
import { fetchLogExemptions, fetchLogRecommendations, fetchLogSegments, hasAdaptiveLogs } from "@/lib/sources/adaptive-logs"
import { useAppStore } from "@/lib/store/app-store"

// Rules → Recommendations under Logs: Grafana Cloud Adaptive Logs' drop-rate
// recommendations per pattern, proposed into Rules as sampling rules, plus
// exemptions (proposed here, created on the next Adaptive Logs apply).

export function useAdaptiveLogRecommendations() {
  const connection = useConnection("logs")
  const cloud = connection ? hasAdaptiveLogs(connection) : false
  return useQuery({
    queryKey: ["adaptive-logs-recommendations", connectionKey(connection)],
    enabled: cloud,
    meta: LOGS_META,
    queryFn: ({ signal }) => fetchLogRecommendations(connection!, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

function useAdaptiveLogsExtras() {
  const connection = useConnection("logs")
  const cloud = connection ? hasAdaptiveLogs(connection) : false
  const key = connectionKey(connection)
  const segments = useQuery({
    queryKey: ["adaptive-logs-segments", key],
    enabled: cloud,
    meta: LOGS_META,
    queryFn: ({ signal }) => fetchLogSegments(connection!, signal),
    retry: false,
    staleTime: 10 * 60_000,
  })
  const exemptions = useQuery({
    queryKey: ["adaptive-logs-exemptions", key],
    enabled: cloud,
    meta: LOGS_META,
    queryFn: ({ signal }) => fetchLogExemptions(connection!, signal),
    retry: false,
    staleTime: 60_000,
  })
  return { segments, exemptions }
}

const pct = (value: number) => (value > 0 && value < 0.1 ? "<0.1%" : `${Math.round(value * 10) / 10}%`)

function ExemptionDialog({
  open,
  onOpenChange,
  initialReason,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialReason?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <ExemptionForm initialReason={initialReason} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  )
}

function ExemptionForm({ initialReason, onDone }: { initialReason?: string; onDone: () => void }) {
  const groupLabel = useAppStore((state) => state.logsSnapshot?.groupLabel ?? "service_name")
  const [selector, setSelector] = React.useState(() => `{${groupLabel}=""}`)
  const [reason, setReason] = React.useState(initialReason ?? "")
  const selectorIssue = selector.trim() ? exemptionProblem({ stream_selector: selector.trim() }) : "Enter a stream selector."
  const cleanReason = reason.replace(/\s+/g, " ").trim().slice(0, 500)
  const problem = selectorIssue ?? (cleanReason ? null : "Say why these streams must stay.")

  const submit = () => {
    if (problem) return
    const input = exemptionToKeepRule({ stream_selector: selector.trim(), reason: cleanReason })
    if (!input) return
    try {
      const next = useAppStore.getState().logRules
      const before = next.length
      useAppStore.getState().activateLogRule({ ...input, status: "active" })
      if (useAppStore.getState().logRules.length === before) {
        toast.info("A keep rule already covers these streams")
        return
      }
    } catch (error) {
      toast.error("Couldn't add the keep rule", { description: error instanceof Error ? error.message : String(error) })
      return
    }
    toast.success("Keep rule added", { description: "Drops leave these streams alone, and Adaptive Logs gets an exemption on the next Apply (Rules → Export)." })
    onDone()
  }

  return (
    <>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keep these streams</DialogTitle>
          <DialogDescription>
            A keep rule protects the streams from your other log rules, and becomes an Adaptive Logs exemption on the next apply, so Adaptive Logs
            never drops their lines whatever the recommendations say.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={Boolean(selectorIssue && selector.trim()) || undefined}>
            <FieldLabel htmlFor="exemption-selector">Stream selector</FieldLabel>
            <Input id="exemption-selector" className="font-mono text-xs" value={selector} onChange={(event) => setSelector(event.target.value)} />
            {selectorIssue && selector.trim() ? <FieldError>{selectorIssue}</FieldError> : <FieldDescription>For example {`{${groupLabel}="checkout"}`}.</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel htmlFor="exemption-reason">Why they must stay</FieldLabel>
            <Input id="exemption-reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Needed for the audit trail" />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button disabled={Boolean(problem)} onClick={submit}>
            <ShieldCheckIcon data-icon="inline-start" />
            Keep
          </Button>
        </DialogFooter>
      </DialogContent>
    </>
  )
}

function Exemptions({ onAdd }: { onAdd: () => void }) {
  const { exemptions: remote } = useAdaptiveLogsExtras()
  const rules = useAppStore((state) => state.logRules)
  const list = React.useMemo(() => remote.data ?? [], [remote.data])
  const pending = React.useMemo(() => {
    const active = rules.filter((rule) => rule.status === "active")
    return planExemptions(compileAdaptiveLogs(active).exemptions, list).create
  }, [rules, list])
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
            Exemptions
            <span className="font-normal text-muted-foreground">
              {remote.isPending ? "loading…" : `${list.length} in Grafana Cloud${pending.length ? `, ${pending.length} from keep rules on apply` : ""}`}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" />
            Keep streams
          </Button>
        </div>
        {remote.error ? <p className="text-xs text-destructive">Couldn't list exemptions: {remote.error.message}</p> : null}
        {list.length || pending.length ? (
          <ul className="flex flex-col gap-1 text-xs">
            {pending.map((item) => (
              <li key={`pending:${item.stream_selector}`} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-brand/40 text-brand-ink">
                  on apply
                </Badge>
                <span className="font-mono break-all">{item.stream_selector}</span>
                {item.reason ? <span className="text-muted-foreground">· {item.reason}</span> : null}
              </li>
            ))}
            {list.map((item) => (
              <li key={item.id ?? item.stream_selector} className="flex flex-wrap items-center gap-2">
                <Badge variant="ghost">{item.expires_at ? "temporary" : "active"}</Badge>
                <span className="font-mono break-all">{item.stream_selector}</span>
                {item.reason ? <span className="text-muted-foreground">· {item.reason}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Recommendations() {
  const navigate = useNavigate()
  const { data, isPending, error } = useAdaptiveLogRecommendations()
  const { segments } = useAdaptiveLogsExtras()
  const logRules = useAppStore((state) => state.logRules)
  const addLogRules = useAppStore((state) => state.addLogRules)
  const [filter, setFilter] = React.useState<"actionable" | "all">("actionable")
  const [exempting, setExempting] = React.useState<{ reason?: string } | null>(null)

  const segmentNames = React.useMemo(
    () => new Map((segments.data ?? []).filter((segment) => segment.id).map((segment) => [segment.id!, segment.name])),
    [segments.data]
  )
  const covered = React.useMemo(() => new Set(logRules.filter((rule) => rule.status !== "rejected").map(logRuleKey)), [logRules])
  const rows = React.useMemo(
    () =>
      recommendationRows(data ?? []).filter(
        (row) => filter === "all" || (!row.recommendation.superseded && !row.recommendation.locked && row.savedBytesPerDay > 0)
      ),
    [data, filter]
  )
  const proposable = (row: RecommendationRow) => {
    const input = recommendationToLogRule(row.recommendation)
    return input && !covered.has(logRuleKey(input)) ? input : null
  }
  const uncovered = rows.filter((row) => proposable(row))
  const totalSaved = rows.reduce((sum, row) => sum + row.savedBytesPerDay, 0)

  function propose(list: RecommendationRow[]) {
    const proposed = list.flatMap((row) => {
      const input = recommendationToLogRule(row.recommendation)
      return input ? [createLogRule(input)] : []
    })
    const { added, skipped } = addLogRules(proposed)
    const skippedText = skipped ? `${skipped} already covered by existing rules` : ""
    if (!added) {
      toast.info(`No new proposals${skippedText ? `: ${skippedText}` : ""}`)
      return
    }
    toast.success(`Added ${added} log proposal${added === 1 ? "" : "s"}`, {
      description: skippedText || "Sampling rules by pattern, for Alloy or Promtail.",
      action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) },
    })
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load Adaptive Logs recommendations</AlertTitle>
        <AlertDescription>{error.message}. The token needs the adaptive-logs:admin scope.</AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label="Recommendations to show"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "actionable", label: "Actionable" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          {rows.length ? (
            <span className="text-sm text-muted-foreground">
              Up to <span className="font-medium text-foreground tabular-nums">{formatBytes(totalSaved)}</span>/day{" "}
              <CostText bytes={totalSaved} per="day" />
            </span>
          ) : null}
          <Button disabled={!uncovered.length} onClick={() => propose(uncovered)}>
            <PlusIcon data-icon="inline-start" />
            Propose all ({uncovered.length})
          </Button>
        </div>
      </div>
      <Card>
        <CardContent>
          {isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={SparkleIcon}
              title="No recommendations"
              description="Adaptive Logs has nothing new to suggest. Recommendations are recalculated every 24 hours."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Term id="logPattern">Pattern</Term>
                  </TableHead>
                  <TableHead className="text-right">Drop rate</TableHead>
                  <TableHead className="hidden text-right md:table-cell">
                    <Term id="logVolume">Volume</Term>
                  </TableHead>
                  <TableHead className="text-right">Saves</TableHead>
                  <TableHead className="hidden lg:table-cell">Queried</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const rec = row.recommendation
                  const input = recommendationToLogRule(rec)
                  const inRules = input ? covered.has(logRuleKey(input)) : false
                  const segmentList = Object.keys(rec.segments ?? {}).map((id) => segmentNames.get(id) ?? id)
                  return (
                    <TableRow key={`${row.pattern}:${segmentList.join(",")}`}>
                      <TableCell className="max-w-0 min-w-56 whitespace-normal">
                        <span className="line-clamp-2 font-mono text-xs break-all" title={row.pattern}>
                          {row.pattern}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {rec.levels?.map((level) => (
                            <Badge key={level} variant="outline">
                              {level}
                            </Badge>
                          ))}
                          {segmentList.map((name) => (
                            <Badge key={name} variant="ghost" className="text-muted-foreground">
                              {name}
                            </Badge>
                          ))}
                          {rec.locked ? (
                            <Badge variant="secondary">
                              <LockSimpleIcon data-icon="inline-start" />
                              locked
                            </Badge>
                          ) : null}
                          {rec.superseded ? <Badge variant="secondary">superseded</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-sm whitespace-nowrap tabular-nums">
                        <span className="text-muted-foreground">{pct(rec.configured_drop_rate)} →</span> {pct(rec.recommended_drop_rate)}
                      </TableCell>
                      <TableCell className="hidden text-right text-sm tabular-nums md:table-cell">{formatBytes(row.bytesPerDay)}/day</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="flex flex-col items-end">
                          <span className="text-sm">{row.savedBytesPerDay > 0 ? `−${formatBytes(row.savedBytesPerDay)}/day` : "0 B"}</span>
                          {row.savedBytesPerDay > 0 ? <CostText bytes={row.savedBytesPerDay} per="day" /> : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground tabular-nums lg:table-cell">
                        {rec.queried_lines.toLocaleString()} of {rec.ingested_lines.toLocaleString()} lines
                        <span className="block">{pct(row.queriedShare * 100)}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-1">
                          {inRules ? (
                            <Badge variant="outline">In rules</Badge>
                          ) : input ? (
                            <Button size="xs" variant="outline" onClick={() => propose([row])}>
                              <PlusIcon data-icon="inline-start" />
                              Propose
                            </Button>
                          ) : null}
                          <Button size="xs" variant="ghost" onClick={() => setExempting({ reason: `Keep lines like: ${row.pattern.slice(0, 200)}` })}>
                            <ShieldCheckIcon data-icon="inline-start" />
                            Keep
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Exemptions onAdd={() => setExempting({})} />
      <ExemptionDialog open={exempting !== null} onOpenChange={(open) => !open && setExempting(null)} initialReason={exempting?.reason} />
    </>
  )
}

/** Rules → Recommendations for logs: Grafana Cloud Adaptive Logs, proposed into Rules. */
export function AdaptiveLogs() {
  const connection = useConnection("logs")
  const cloud = connection ? hasAdaptiveLogs(connection) : false
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Grafana Cloud <Term id="adaptiveLogs">Adaptive Logs</Term> groups your lines into <Term id="logPattern">patterns</Term> and recommends a drop rate for each, from how often queries
        read them over 15 days. Propose a recommendation to get a sampling rule for your collector (it waits in Rules for review), or keep streams
        you must not lose: a <Term id="keepRule">keep rule</Term> protects them from your drops and becomes an exemption on the next Adaptive Logs apply.
      </p>
      {cloud ? (
        <Recommendations />
      ) : (
        <EmptyState
          framed
          icon={FingerprintIcon}
          title="Grafana Cloud Adaptive Logs only"
          description={
            connection
              ? "Adaptive Logs runs in Grafana Cloud and needs a hosted Loki URL (https://logs-prod-….grafana.net) with an adaptive-logs:admin token. On any Loki, the Patterns page finds noisy line patterns you can drop or sample with collector rules."
              : "Connect a logs source first. On Grafana Cloud Loki you get Adaptive Logs recommendations here; on any Loki, the Patterns page finds noisy patterns to drop or sample."
          }
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to={paths.logPatterns}>
                <FingerprintIcon data-icon="inline-start" />
                Open Patterns
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.settings}>Data sources</Link>
            </Button>
          </div>
        </EmptyState>
      )}
    </div>
  )
}
