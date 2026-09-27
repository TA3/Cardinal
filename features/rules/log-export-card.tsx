import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  CloudArrowUpIcon,
  CodeIcon,
  DownloadSimpleIcon,
  GitPullRequestIcon,
  InfoIcon,
  ShieldCheckIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { CodeBlock } from "@/components/code-block"
import { formatCost, useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useLogUsageSummaries } from "@/features/rules/log-usage"
import { downloadFile } from "@/features/rules/share"
import {
  readLogAdaptiveBackup,
  readPendingExemptions,
  readStackUrl,
  storeLogAdaptiveBackup,
  storePendingExemptions,
  storeStackUrl,
  useStorageVersion,
} from "@/features/rules/storage"
import { Term } from "@/features/rules/term"
import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { copyText } from "@/lib/clipboard"
import {
  logApplyDiffs,
  planLogApply,
  planLogRevert,
  exemptionToKeepRule,
  planExemptions,
  type AdaptiveLogsExemption,
  type LogAdaptiveBackup,
  type LogApplyPlan,
} from "@/lib/core/logs/adaptive-apply"
import { compileAdaptiveLogs, type AdaptiveLogsDropRule } from "@/lib/core/logs/compile/adaptive-logs"
import { compileAlloyLogs } from "@/lib/core/logs/compile/alloy"
import { compilableRules, type LogCompileResult } from "@/lib/core/logs/compile/common"
import { compileLokiLimits } from "@/lib/core/logs/compile/loki-limits"
import { compilePromtailLogs } from "@/lib/core/logs/compile/promtail"
import { computeLogSavings } from "@/lib/core/logs/impact"
import { logPrDescription } from "@/lib/core/logs/pr"
import { createLogRule } from "@/lib/core/logs/rules"
import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import type { LogRule, LogRuleKind } from "@/lib/core/logs/types"
import { formatAgo } from "@/lib/core/report"
import {
  createLogDropRule,
  createLogExemption,
  deleteLogDropRule,
  deleteLogExemption,
  fetchLogDropRules,
  fetchLogExemptions,
  hasAdaptiveLogs,
  updateLogDropRule,
} from "@/lib/sources/adaptive-logs"
import { useAppStore } from "@/lib/store/app-store"

type Format = "alloy" | "promtail" | "limits" | "adaptive"

const FORMAT_OPTIONS = [
  { value: "alloy", label: "Alloy" },
  { value: "promtail", label: "Promtail" },
  { value: "limits", label: "Loki limits" },
  { value: "adaptive", label: "Adaptive Logs" },
] as const

const SUPPORTED: Record<Format, readonly LogRuleKind[]> = {
  alloy: ["drop_streams", "drop_lines", "sample", "drop_label", "label_to_metadata"],
  promtail: ["drop_streams", "drop_lines", "sample", "drop_label", "label_to_metadata"],
  limits: ["retention"],
  adaptive: ["drop_streams", "drop_lines", "sample"],
}

const TARGET_NAMES: Record<Format, string> = {
  alloy: "Grafana Alloy loki.process",
  promtail: "Promtail pipeline_stages",
  limits: "Loki limits_config retention_stream",
  adaptive: "Grafana Cloud Adaptive Logs",
}

const FILE_NAMES: Record<Format, string> = {
  alloy: "cardinal-logs.alloy",
  promtail: "cardinal-pipeline-stages.yml",
  limits: "cardinal-loki-limits.yml",
  adaptive: "cardinal-adaptive-logs.json",
}

function WhereItRuns({ format }: { format: Format }) {
  if (format === "adaptive") {
    return (
      <>
        Runs in Grafana Cloud as logs arrive: matching lines are dropped (or a share of them) before they're stored and billed. The collector
        still sends them. Only stream selectors plus levels or plain substrings; label moves and retention don't apply.
      </>
    )
  }
  if (format === "limits") {
    return (
      <>
        Runs in Loki's compactor: <code className="font-mono">retention_stream</code> deletes matching <Term id="logStream">streams</Term>{" "}
        after the period. Storage only; ingest (and the ingest bill) is unchanged.
      </>
    )
  }
  return (
    <>
      Runs in {format === "alloy" ? "Grafana Alloy" : "Promtail"} before logs are sent: dropped lines never leave the collector, cutting{" "}
      <Term id="logVolume">volume</Term> and network. Label moves to <Term id="structuredMetadata">structured metadata</Term> shrink streams, not
      bytes.
    </>
  )
}

const ALLOY_WIRING = `// Send your sources to the cardinal block…
loki.source.kubernetes "pods" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [loki.process.cardinal.receiver]
}

// …and keep its forward_to on your existing loki.write.
loki.write "default" {
  endpoint { url = "https://…/loki/api/v1/push" }
}`

function PasteInstructions({ format }: { format: Format }) {
  const steps: React.ReactNode[] =
    format === "adaptive"
      ? [
          "On a Grafana Cloud Loki connection, use Apply below: it merges these into your Adaptive Logs drop rules and keeps a copy for revert.",
          "Or POST each entry to <loki-url>/adaptive-logs/drop-rules with basic auth <instance-id>:<token> (scope adaptive-logs:admin).",
          "Drop rules take effect within minutes; check them in the Adaptive Logs app.",
        ]
      : format === "limits"
        ? [
            <>
              Merge the <code className="font-mono">retention_stream</code> list into <code className="font-mono">limits_config</code> (or a
              tenant's runtime overrides).
            </>,
            <>
              Retention needs the compactor with <code className="font-mono">retention_enabled: true</code>. Periods are at least 24h; the
              highest priority wins where selectors overlap.
            </>,
            "Restart Loki or reload the runtime config. On Grafana Cloud, ask support to set per-stream retention.",
          ]
        : format === "alloy"
          ? [
              "Add the block to your Alloy config.",
              <>
                Point your log sources' <code className="font-mono">forward_to</code> at{" "}
                <code className="font-mono">[loki.process.cardinal.receiver]</code>, and keep this block's{" "}
                <code className="font-mono">forward_to</code> on your <code className="font-mono">loki.write</code> receiver.
              </>,
              "Reload Alloy and check the component graph in the Alloy UI.",
            ]
          : [
              <>
                Append the stages to the <code className="font-mono">pipeline_stages</code> of each scrape config that ships these logs, after
                any stage that sets the labels the selectors use.
              </>,
              "Restart Promtail. (Promtail is in maintenance; Alloy takes the same stages as loki.process.)",
            ]
  return (
    <Collapsible className="rounded-xl border border-well-border bg-background/40 text-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-left font-medium outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50">
        <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Where to paste it
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">
        <ol className="flex list-decimal flex-col gap-1 pl-4 text-muted-foreground">
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        {format === "alloy" ? <CodeBlock code={ALLOY_WIRING} maxHeight="max-h-60" className="[&_pre]:break-normal [&_pre]:whitespace-pre" /> : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Notes({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <Alert>
      <WarningIcon />
      <AlertTitle>{warnings.length === 1 ? "1 note" : `${warnings.length} notes`}</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Grafana stack URL → the Adaptive Logs app. */
function adaptiveLogsAppUrl(stack: string) {
  try {
    const url = new URL(stack.trim())
    if (url.protocol !== "https:" || !url.hostname.endsWith(".grafana.net")) return null
    return `${url.origin}/a/grafana-adaptivelogs-app`
  } catch {
    return null
  }
}

function AdaptiveLogsUiLink() {
  const version = useStorageVersion()
  const stored = React.useMemo(() => {
    void version
    return readStackUrl()
  }, [version])
  const [draft, setDraft] = React.useState("")
  const url = adaptiveLogsAppUrl(stored)
  if (url) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-ink hover:underline">
          Open Adaptive Logs in Grafana Cloud
          <ArrowSquareOutIcon className="size-3.5" />
        </a>
        <button type="button" className="text-muted-foreground hover:underline" onClick={() => storeStackUrl("")}>
          change stack
        </button>
      </div>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault()
        if (adaptiveLogsAppUrl(draft)) storeStackUrl(draft.trim())
        else toast.error("Enter your Grafana stack URL, e.g. https://mystack.grafana.net")
      }}
    >
      <span className="text-muted-foreground">Link to the Adaptive Logs UI:</span>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="https://mystack.grafana.net"
        aria-label="Grafana stack URL"
        className="h-7 w-52 text-xs"
      />
      <Button size="xs" variant="outline" type="submit">
        Save
      </Button>
    </form>
  )
}

/**
 * Exemptions proposed before keep rules existed were kept in this browser until
 * the next apply; they become proposed keep rules (once per connection).
 */
export function useLegacyExemptionsMigration() {
  const connection = useConnection("logs")
  const connKey = connectionKey(connection)
  React.useEffect(() => {
    if (!connection) return
    const legacy = readPendingExemptions(connKey)
    if (!legacy.length) return
    const inputs = legacy.map(exemptionToKeepRule).filter((input) => input !== null)
    const { added } = useAppStore.getState().addLogRules(inputs.map((input) => createLogRule(input)))
    storePendingExemptions(connKey, [])
    if (added) toast.info(`${added} proposed exemption${added === 1 ? " is" : "s are"} now keep rules`, { description: "Review them under Proposed; they become exemptions on the next apply." })
  }, [connection, connKey])
}

interface Review {
  signature: string
  plan: LogApplyPlan
  compileWarnings: string[]
  /** Exemptions for keep rules that Grafana Cloud doesn't have yet. */
  exemptions: AdaptiveLogsExemption[]
}

function rulesSignature(rules: LogRule[]) {
  return JSON.stringify(rules.map((rule) => [rule.id, rule.status, rule.kind === "sample" ? rule.keep : null]))
}

function ApplyToAdaptiveLogs({ rules }: { rules: LogRule[] }) {
  const connection = useConnection("logs")
  const connKey = connectionKey(connection)
  const log = useAppStore((state) => state.log)
  const version = useStorageVersion()
  const backup = React.useMemo(() => {
    void version
    return readLogAdaptiveBackup(connKey)
  }, [version, connKey])
  const exemptions = React.useMemo(() => compileAdaptiveLogs(rules).exemptions, [rules])
  const [pending, setPending] = React.useState(false)
  const [reviewState, setReview] = React.useState<Review | null>(null)
  const [revertOpen, setRevertOpen] = React.useState(false)
  const signature = React.useMemo(() => rulesSignature(rules), [rules])
  const review = reviewState?.signature === signature ? reviewState : null
  const diffs = React.useMemo(() => (review ? logApplyDiffs(review.plan) : []), [review])
  const changeCount = (review?.plan.changes.length ?? 0) + (review?.exemptions.length ?? 0)

  async function startReview() {
    if (!connection) return
    setPending(true)
    try {
      const compiled = compileAdaptiveLogs(rules)
      const [existing, remoteExemptions] = await Promise.all([fetchLogDropRules(connection), fetchLogExemptions(connection)])
      const { create } = planExemptions(compiled.exemptions, remoteExemptions)
      setReview({ signature, plan: planLogApply(compiled.dropRules, existing), compileWarnings: compiled.warnings, exemptions: create })
    } catch (error) {
      toast.error("Could not read Adaptive Logs drop rules", { description: `${errorText(error)}. The token needs the adaptive-logs:admin scope.` })
    } finally {
      setPending(false)
    }
  }

  async function apply() {
    if (!connection || !review) return
    setPending(true)
    const previous = readLogAdaptiveBackup(connKey)
    const next: LogAdaptiveBackup = { appliedAt: new Date().toISOString(), updated: [], created: [], applied: {}, exemptions: [] }
    // The revert point is saved before the first write and after each one, so a closed tab can still revert.
    if (!storeLogAdaptiveBackup(connKey, next)) {
      toast.error("Could not save a backup of the current rules in this browser; not applying.")
      setPending(false)
      return
    }
    let done = 0
    try {
      for (const change of review.plan.changes) {
        let id: string
        if (change.type === "create") {
          const written: AdaptiveLogsDropRule = await createLogDropRule(connection, change.rule)
          if (!written.id) throw new Error("Grafana Cloud created a drop rule without returning its id; remove it in the Adaptive Logs app")
          id = written.id
          next.created.push(id)
        } else {
          id = change.before.id!
          await updateLogDropRule(connection, id, change.rule)
          next.updated.push(change.before)
        }
        next.applied[id] = change.rule.body
        storeLogAdaptiveBackup(connKey, next)
        done += 1
      }
      for (const exemption of review.exemptions) {
        const created = await createLogExemption(connection, exemption)
        if (created.id) next.exemptions!.push(created.id)
        storeLogAdaptiveBackup(connKey, next)
        done += 1
      }
      log(`Applied ${done} Adaptive Logs changes`)
      toast.success(`Applied ${done} change${done === 1 ? "" : "s"} to Adaptive Logs`, { description: "You can revert this apply from the Export card." })
      setReview(null)
    } catch (error) {
      if (done === 0) storeLogAdaptiveBackup(connKey, previous)
      toast.error(done ? `Stopped after ${done} of ${changeCount} changes` : "Nothing was applied", {
        description: `${errorText(error)}${done ? ". Revert last apply undoes the ones that went through." : ""}`,
      })
    } finally {
      setPending(false)
    }
  }

  async function revert() {
    if (!connection || !backup) return
    setPending(true)
    try {
      const current = await fetchLogDropRules(connection)
      const plan = planLogRevert(backup, current)
      if (!plan.ok) {
        toast.error("Not reverted", { description: plan.reason })
        return
      }
      for (const step of plan.steps) {
        if (step.type === "delete") await deleteLogDropRule(connection, step.id)
        else if (step.type === "restore") await updateLogDropRule(connection, step.id, step.rule)
        else await deleteLogExemption(connection, step.id).catch(() => undefined)
      }
      storeLogAdaptiveBackup(connKey, null)
      log(`Reverted the Adaptive Logs apply from ${backup.appliedAt}`)
      toast.success("Reverted the last apply", {
        description: plan.missing ? `${plan.missing} rule${plan.missing === 1 ? " was" : "s were"} already gone.` : undefined,
      })
      setRevertOpen(false)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setPending(false)
    }
  }

  const created = review?.plan.changes.filter((change) => change.type === "create").length ?? 0
  const updated = (review?.plan.changes.length ?? 0) - created
  const backupSize = backup ? backup.created.length + backup.updated.length + (backup.exemptions?.length ?? 0) : 0

  return (
    <div className="flex flex-col gap-2">
      {exemptions.length ? (
        <div className="flex flex-col gap-1 rounded-xl border border-well-border bg-background/40 px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <ShieldCheckIcon className="size-3.5 text-muted-foreground" aria-hidden />
            {exemptions.length} keep rule{exemptions.length === 1 ? "" : "s"} become exemptions on apply
          </span>
          <ul className="flex flex-col gap-0.5">
            {exemptions.map((item) => (
              <li key={item.stream_selector} className="min-w-0 truncate font-mono" title={item.reason}>
                {item.stream_selector}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || (rules.length === 0 && exemptions.length === 0)} onClick={() => void startReview()}>
          {pending && !review && !revertOpen ? <Spinner data-icon="inline-start" /> : <CloudArrowUpIcon data-icon="inline-start" />}
          Apply to Adaptive Logs
        </Button>
        {backup ? (
          <Button variant="outline" disabled={pending} onClick={() => setRevertOpen(true)}>
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            Revert last apply
          </Button>
        ) : null}
      </div>
      <AdaptiveLogsUiLink />
      <AlertDialog open={Boolean(review)} onOpenChange={(open) => !open && setReview(null)}>
        <AlertDialogContent className="sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to Adaptive Logs?</AlertDialogTitle>
            <AlertDialogDescription>
              {changeCount
                ? `${created} new and ${updated} updated drop rule${created + updated === 1 ? "" : "s"}${review?.exemptions.length ? `, ${review.exemptions.length} exemption${review.exemptions.length === 1 ? "" : "s"}` : ""}. ${review?.plan.unchanged.length ?? 0} already in place. Other drop rules in Grafana Cloud stay as they are. What Cardinal changes is saved in this browser so you can revert.`
                : "Grafana Cloud already has these drop rules."}
              {backup && changeCount ? ` This replaces the revert point of the apply ${formatAgo(backup.appliedAt) ?? "before"}.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {diffs.length || review?.plan.kept.length ? (
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
              {diffs.map((diff) => (
                <li key={`${diff.type}:${diff.selector}:${diff.after}`} className="rounded-lg border border-border px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={diff.type === "create" ? "outline" : "secondary"}>{diff.type === "create" ? "new" : "update"}</Badge>
                    <span className="min-w-0 truncate font-mono" title={diff.selector}>
                      {diff.selector}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground">before</span>
                    <span className={diff.before ? "line-through decoration-muted-foreground/60" : "text-muted-foreground"}>
                      {diff.before ?? "no drop rule"}
                    </span>
                    <span className="text-muted-foreground">after</span>
                    <span>{diff.after}</span>
                  </div>
                </li>
              ))}
              {review?.plan.kept.map(({ rule, remote }) => (
                <li key={`kept:${remote.id}`} className="rounded-lg border border-dashed border-border px-2.5 py-1.5 text-muted-foreground">
                  <Badge variant="ghost">kept</Badge> <span className="font-mono">{rule.body.stream_selector}</span>: Grafana Cloud already drops{" "}
                  {remote.body.drop_rate}% (Cardinal asks {rule.body.drop_rate}%).
                </li>
              ))}
            </ul>
          ) : null}
          <Notes warnings={[...(review?.compileWarnings ?? []), ...(review?.plan.warnings ?? [])]} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || !changeCount}
              onClick={(event) => {
                event.preventDefault()
                void apply()
              }}
            >
              {pending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Apply {changeCount} change{changeCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={revertOpen} onOpenChange={setRevertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert the last apply?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the {backup?.created.length ?? 0} drop rules Cardinal created, restores the {backup?.updated.length ?? 0} it changed
              {backup?.exemptions?.length ? ` and removes its ${backup.exemptions.length} exemptions` : ""} ({backupSize} changes{" "}
              {formatAgo(backup?.appliedAt) ?? ""}). It only goes ahead if nobody changed those rules since.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault()
                void revert()
              }}
            >
              {pending ? <Spinner data-icon="inline-start" /> : <ArrowCounterClockwiseIcon data-icon="inline-start" />}
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function compile(format: Format, rules: LogRule[], range: string | undefined, now: Date): LogCompileResult {
  const options = { now, range }
  if (format === "alloy") return compileAlloyLogs(rules, options)
  if (format === "promtail") return compilePromtailLogs(rules, options)
  if (format === "limits") return compileLokiLimits(rules, options)
  return compileAdaptiveLogs(rules, options)
}

/** Rules → Export under Logs: collector stages, Loki limits or Adaptive Logs drop rules, plus apply on Grafana Cloud. */
export function LogExportCard({ rules }: { rules: LogRule[] }) {
  const snapshot = useAppStore((state) => state.logsSnapshot)
  const connection = useConnection("logs")
  const cloud = connection ? hasAdaptiveLogs(connection) : false
  const { cost } = useBytesCost()
  const [format, setFormat] = React.useState<Format>(cloud ? "adaptive" : "alloy")
  const generatedAt = React.useMemo(() => new Date(), [rules, format]) // eslint-disable-line react-hooks/exhaustive-deps
  const range = snapshot?.range

  const result = React.useMemo(() => compile(format, rules, range, generatedAt), [format, rules, range, generatedAt])
  const { emitted, keeps } = React.useMemo(() => {
    const { rules: selected, keeps } = compilableRules(rules, SUPPORTED[format], TARGET_NAMES[format])
    return { emitted: format === "adaptive" ? selected.filter((rule) => rule.selector.matchers.length > 0) : selected, keeps }
  }, [rules, format])
  const { summaries } = useLogUsageSummaries(emitted, emitted.length > 0)
  const empty =
    format === "adaptive"
      ? result.text.trim() === "[]"
      : /^(\/\/ No log rules|# No retention rules|pipeline_stages: \[\])/.test(result.text)
  const rangeDays = snapshot ? LOGS_RANGE_SECONDS[snapshot.range] / 86400 : 1

  const copyPr = async () => {
    try {
      await copyText(
        logPrDescription(emitted, {
          generatedAt,
          target: TARGET_NAMES[format],
          rangeDays,
          totalBytesPerDay: snapshot ? snapshot.totals.bytes / rangeDays : 0,
          totalStreams: snapshot?.totals.streams ?? 0,
          savings: computeLogSavings([...emitted, ...keeps], snapshot),
          keeps,
          cost,
          formatCost,
          usage: Object.fromEntries(Object.entries(summaries).map(([id, summary]) => [id, summary.used ? summary.found.join("; ") : null])),
        })
      )
      toast.success("PR description copied", { description: "Markdown with a rules table and each rule's rationale." })
    } catch {
      toast.error("Could not copy the PR description")
    }
  }

  return (
    <Frame>
      <FrameHeader icon={CodeIcon} title="Export" meta={format === "adaptive" ? "drop rules" : format === "limits" ? "retention" : "pipeline stages"} />
      <FrameWell className="flex flex-col gap-3 py-4">
        <SegmentedControl stretch aria-label="Export format" value={format} onValueChange={setFormat} options={FORMAT_OPTIONS} />
        <p className="text-xs text-pretty text-muted-foreground">
          <WhereItRuns format={format} />
        </p>
        <Notes warnings={result.warnings} />
        {empty ? (
          <EmptyState
            compact
            icon={CodeIcon}
            title={rules.length ? "Nothing to export in this format" : "Nothing to export yet"}
            description={
              rules.length
                ? format === "limits"
                  ? "Only retention rules become Loki limits."
                  : "None of the active rules can ship this way; see the notes above."
                : "Active log rules turn into Alloy or Promtail stages, Loki retention or Adaptive Logs drop rules here."
            }
            className="rounded-2xl border border-dashed border-well-border bg-background/40"
          />
        ) : (
          <>
            <CodeBlock code={result.text} className="[&_pre]:break-normal [&_pre]:whitespace-pre" />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadFile(FILE_NAMES[format], result.text, format === "adaptive" ? "application/json" : "text/plain")}
              >
                <DownloadSimpleIcon data-icon="inline-start" />
                Download {FILE_NAMES[format].slice(FILE_NAMES[format].lastIndexOf("."))}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyPr()}>
                <GitPullRequestIcon data-icon="inline-start" />
                Copy PR description
              </Button>
            </div>
            <PasteInstructions format={format} />
          </>
        )}
        {format === "adaptive" ? (
          cloud ? (
            <ApplyToAdaptiveLogs rules={rules} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Apply needs a Grafana Cloud Loki connection (https://logs-prod-….grafana.net) with an adaptive-logs:admin token; a Grafana data
              source proxy can't reach the Adaptive Logs API.
            </p>
          )
        ) : null}
      </FrameWell>
    </Frame>
  )
}
