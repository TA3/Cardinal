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
  WarningIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { CodeBlock } from "@/components/code-block"
import { formatCost, useCost } from "@/components/cost-text"
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
import { downloadFile } from "@/features/rules/share"
import { readAdaptiveBackup, readImportBaseline, readStackUrl, storeAdaptiveBackup, storeStackUrl, useStorageVersion } from "@/features/rules/storage"
import { Term } from "@/features/rules/term"
import { useUsageSummaries } from "@/features/rules/usage"
import { connectionKey, useConnection, useIsGrafanaCloud } from "@/hooks/use-cardinality"
import { copyText } from "@/lib/clipboard"
import {
  adaptiveChangeDiffs,
  compileAdaptiveMetrics,
  planRevert,
  renderAdaptiveMetrics,
  type AdaptiveBackup,
  type AdaptiveCompileResult,
  type AggregationRule,
} from "@/lib/core/compile/adaptive-metrics"
import { renderAlloy } from "@/lib/core/compile/alloy"
import { planRelabel, type RelabelMode } from "@/lib/core/compile/plan"
import { renderPrometheus, type PrometheusStage } from "@/lib/core/compile/prometheus"
import { describeRule, formatAgo, prDescription, renderHeader, type ReportContext } from "@/lib/core/report"
import { describeKey, diffAgainstBaseline, fingerprint } from "@/lib/core/rule-diff"
import { isShadowed, type Rule } from "@/lib/core/rules"
import { computeExpectedSavings } from "@/lib/core/savings"
import { jobsByMetric } from "@/lib/core/snapshot"
import { checkAggregationRules, fetchAggregationRules, saveAggregationRules } from "@/lib/sources/adaptive-metrics"
import { useAppStore } from "@/lib/store/app-store"

type Format = "prometheus" | "alloy" | "adaptive"

const FORMAT_OPTIONS = [
  { value: "prometheus", label: "Prometheus" },
  { value: "alloy", label: "Alloy" },
  { value: "adaptive", label: "Adaptive Metrics" },
] as const

const STAGE_OPTIONS = [
  { value: "scrape", label: "At scrape", title: "metric_relabel_configs: dropped before Prometheus stores anything" },
  { value: "remote_write", label: "On remote write", title: "write_relabel_configs: full data stays local, only the remote copy is cut" },
] as const

const LAYOUT_OPTIONS = [
  { value: "combined", label: "Combined", title: "One rule set for every scrape job" },
  { value: "split-by-job", label: "Per scrape job", title: "A block per scrape job, holding only the drops that apply to it" },
] as const

/** Where each output runs and what it saves, in one line. */
function WhereItRuns({ format, stage }: { format: Format; stage: PrometheusStage }) {
  if (format === "adaptive") {
    return (
      <>
        Runs in Grafana Cloud as data arrives: series are <Term id="relabelVsAggregation">aggregated</Term> before storage, so you pay
        for the aggregated series. The raw series are still sent. Safe for label drops that <Term id="mergesSeries">merge series</Term>.
      </>
    )
  }
  if (format === "alloy") {
    return (
      <>
        Runs in Grafana Alloy between scrape and remote_write: dropped series never leave the collector, cutting the remote bill and
        network. Label drops that merge series are left out.
      </>
    )
  }
  return stage === "remote_write" ? (
    <>
      Runs in Prometheus on the way out (<Term id="metricVsWriteRelabel">write_relabel_configs</Term>): the full data stays in local
      storage, only what's shipped to the remote backend (and billed there) is cut.
    </>
  ) : (
    <>
      Runs in Prometheus at scrape time (<Term id="metricVsWriteRelabel">metric_relabel_configs</Term>): dropped series are never stored
      locally or sent to remote_write, so it saves memory and the remote bill.
    </>
  )
}

const ALLOY_WIRING = `// Point your scrape component at the relabel block…
prometheus.scrape "app" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [prometheus.relabel.cardinal.receiver]
}

// …and keep the relabel block's forward_to on your existing remote_write.
prometheus.remote_write "default" {
  endpoint { url = "https://…/api/prom/push" }
}`

function PasteInstructions({ format, stage, mode }: { format: Format; stage: PrometheusStage; mode: RelabelMode }) {
  const steps: React.ReactNode[] =
    format === "adaptive"
      ? [
          "On Grafana Cloud, use Apply below: it merges these into your current Adaptive Metrics rules and keeps a copy for revert.",
          "Or send the JSON to the Adaptive Metrics API (POST /aggregations/rules replaces the whole set, so merge with the current rules first).",
          "Aggregated series take effect within minutes; recommendations update daily.",
        ]
      : format === "alloy"
        ? [
            "Add the block to your Alloy config file.",
            <>
              Wire it between scrape and remote write: set your <code className="font-mono">prometheus.scrape</code> component's{" "}
              <code className="font-mono">forward_to</code> to <code className="font-mono">[prometheus.relabel.cardinal.receiver]</code>
              {mode === "split-by-job" ? " (per-job blocks: each job's scrape component points at its own block)" : ""}, and set this
              block's <code className="font-mono">forward_to</code> to your <code className="font-mono">prometheus.remote_write</code>{" "}
              receiver (rename <code className="font-mono">default</code> to match yours).
            </>,
            "Reload Alloy (POST /-/reload or restart) and check the component graph in the Alloy UI.",
          ]
        : stage === "remote_write"
          ? [
              <>
                Copy the <code className="font-mono">write_relabel_configs</code> list into the existing{" "}
                <code className="font-mono">remote_write</code> entry that ships to your remote backend. Don't add a second remote_write
                with the placeholder URL.
              </>,
              "Check with promtool check config, then reload Prometheus (SIGHUP or POST /-/reload).",
            ]
          : [
              mode === "split-by-job" ? (
                <>
                  Merge each job's <code className="font-mono">metric_relabel_configs</code> into the{" "}
                  <code className="font-mono">scrape_config</code> with that <code className="font-mono">job_name</code>; the part not
                  tied to a job goes into every scrape config.
                </>
              ) : (
                <>
                  Paste the list under <code className="font-mono">metric_relabel_configs</code> in each{" "}
                  <code className="font-mono">scrape_config</code> that scrapes these metrics. Job-scoped rules match on the job label, so
                  they are safe in any scrape config.
                </>
              ),
              "Check with promtool check config, then reload Prometheus (SIGHUP or POST /-/reload).",
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
      <AlertTitle>{warnings.length === 1 ? "1 rule needs attention" : `${warnings.length} rules need attention`}</AlertTitle>
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

/** New versus already-deployed rules, when rules were imported. */
function ImportDiff({ rules }: { rules: Rule[] }) {
  const version = useStorageVersion()
  const baseline = React.useMemo(() => {
    void version
    // Only relabel imports record a baseline; shared rule sets are proposals, not deployed config.
    return readImportBaseline() ?? []
  }, [version])
  const diff = React.useMemo(() => diffAgainstBaseline(baseline, rules), [baseline, rules])
  if (baseline.length === 0) return null
  const parts = [
    diff.added.length ? `${diff.added.length} new` : null,
    diff.changed.length ? `${diff.changed.length} changed` : null,
    diff.unchanged.length ? `${diff.unchanged.length} already in place` : null,
    diff.removed.length ? `${diff.removed.length} removed` : null,
  ].filter(Boolean)
  return (
    <Collapsible className="rounded-xl border border-well-border bg-background/40 text-xs">
      <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-1.5 rounded-xl px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className="font-medium">Compared with your imported rules:</span>
        <span className="text-muted-foreground">{parts.join(" · ") || "no changes"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 px-3 pb-3">
        {diff.added.map((rule) => (
          <p key={rule.id} className="flex gap-2">
            <Badge variant="outline" className="border-brand/40 text-brand-ink">
              new
            </Badge>
            <span className="min-w-0 break-all">{describeRule(rule)}</span>
          </p>
        ))}
        {diff.changed.map(({ rule, before }) => (
          <p key={rule.id} className="flex gap-2">
            <Badge variant="secondary">changed</Badge>
            <span className="min-w-0 break-all">
              {describeRule(rule)} <span className="text-muted-foreground">(was {before.join(", ") || "none"})</span>
            </span>
          </p>
        ))}
        {diff.unchanged.map((rule) => (
          <p key={rule.id} className="flex gap-2 text-muted-foreground">
            <Badge variant="ghost">existing</Badge>
            <span className="min-w-0 break-all">{describeRule(rule)}</span>
          </p>
        ))}
        {diff.removed.map((item) => (
          <p key={item.key} className="flex gap-2 text-muted-foreground">
            <Badge variant="ghost" className="line-through">
              removed
            </Badge>
            <span className="min-w-0 break-all">{describeKey(item.key)}</span>
          </p>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** What a review depends on; impacts are left out since they change without the rules changing. */
function rulesSignature(rules: Rule[]) {
  return JSON.stringify(rules.map((rule) => [fingerprint(rule), rule.status]))
}

interface Review {
  signature: string
  result: AdaptiveCompileResult
  existing: AggregationRule[]
  etag: string
  errors: string[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Grafana stack URL (https://<stack>.grafana.net) for linking to the Adaptive Metrics app. */
function stackAppUrl(stack: string) {
  try {
    const url = new URL(stack.trim())
    if (url.protocol !== "https:" || !url.hostname.endsWith(".grafana.net")) return null
    return `${url.origin}/a/grafana-adaptive-metrics-app`
  } catch {
    return null
  }
}

function AdaptiveUiLink() {
  const version = useStorageVersion()
  const stored = React.useMemo(() => {
    void version
    return readStackUrl()
  }, [version])
  const [draft, setDraft] = React.useState("")
  const url = stackAppUrl(stored)
  if (url) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-ink hover:underline">
          Open Adaptive Metrics in Grafana Cloud
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
        if (stackAppUrl(draft)) storeStackUrl(draft.trim())
        else toast.error("Enter your Grafana stack URL, e.g. https://mystack.grafana.net")
      }}
    >
      <span className="text-muted-foreground">Link to the Adaptive Metrics UI:</span>
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

function ApplyToGrafanaCloud({ rules }: { rules: Rule[] }) {
  const connection = useConnection()
  const connKey = connectionKey(connection)
  const log = useAppStore((state) => state.log)
  const version = useStorageVersion()
  const backup = React.useMemo(() => {
    void version
    return readAdaptiveBackup(connKey)
  }, [version, connKey])
  const [pending, setPending] = React.useState(false)
  const [reviewState, setReview] = React.useState<Review | null>(null)
  const [revertOpen, setRevertOpen] = React.useState(false)
  // A review is only valid for the rules it was computed from.
  const signature = React.useMemo(() => rulesSignature(rules), [rules])
  const review = reviewState?.signature === signature ? reviewState : null
  const diffs = React.useMemo(() => (review ? adaptiveChangeDiffs(review.result.changes) : []), [review])

  async function startReview() {
    if (!connection) return
    setPending(true)
    try {
      const existing = await fetchAggregationRules(connection)
      const result = compileAdaptiveMetrics(rules, existing.rules)
      const errors = result.changes.length ? await checkAggregationRules(connection, result.rules) : []
      setReview({ signature: rulesSignature(rules), result, existing: existing.rules, etag: existing.etag, errors })
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setPending(false)
    }
  }

  async function apply() {
    if (!connection || !review) return
    setPending(true)
    const before = readAdaptiveBackup(connKey)
    const next: AdaptiveBackup = {
      appliedAt: new Date().toISOString(),
      previous: review.existing,
      previousEtag: review.etag,
      applied: review.result.rules,
      changes: review.result.changes.length,
    }
    // Keep the previous remote set before writing, so a revert is possible even if the tab closes mid-apply.
    if (!storeAdaptiveBackup(connKey, next)) {
      toast.error("Could not save a backup of the current rules in this browser; not applying.")
      setPending(false)
      return
    }
    try {
      await saveAggregationRules(connection, review.result.rules, review.etag)
      log(`Applied ${review.result.changes.length} Adaptive Metrics rule changes`)
      toast.success(`Applied ${review.result.changes.length} changes to Grafana Cloud`, { description: "You can revert this apply from the Export card." })
      setReview(null)
    } catch (error) {
      storeAdaptiveBackup(connKey, before)
      toast.error(errorText(error))
    } finally {
      setPending(false)
    }
  }

  async function revert() {
    if (!connection) return
    setPending(true)
    try {
      const current = await fetchAggregationRules(connection)
      const plan = planRevert(backup, current.rules, current.etag)
      if (!plan.ok) {
        toast.error("Not reverted", { description: plan.reason })
        return
      }
      await saveAggregationRules(connection, plan.rules, plan.etag)
      storeAdaptiveBackup(connKey, null)
      log(`Reverted the Adaptive Metrics apply from ${backup?.appliedAt ?? "earlier"}`)
      toast.success("Reverted to the rules before the last apply")
      setRevertOpen(false)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setPending(false)
    }
  }

  const added = review?.result.changes.filter((change) => change.type === "add").length ?? 0
  const updated = (review?.result.changes.length ?? 0) - added

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || rules.length === 0} onClick={() => void startReview()}>
          {pending && !review && !revertOpen ? <Spinner data-icon="inline-start" /> : <CloudArrowUpIcon data-icon="inline-start" />}
          Apply to Grafana Cloud
        </Button>
        {backup ? (
          <Button variant="outline" disabled={pending} onClick={() => setRevertOpen(true)}>
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            Revert last apply
          </Button>
        ) : null}
      </div>
      <AdaptiveUiLink />
      <AlertDialog open={Boolean(review)} onOpenChange={(open) => !open && setReview(null)}>
        <AlertDialogContent className="sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply Adaptive Metrics rules?</AlertDialogTitle>
            <AlertDialogDescription>
              {review?.result.changes.length
                ? `${added} new and ${updated} updated aggregation rules. ${(review?.result.rules.length ?? 0) - (review?.result.changes.length ?? 0)} existing rules stay unchanged. Aggregated series stop being stored at full resolution. The current rules are saved in this browser so you can revert.`
                : "Grafana Cloud already has these rules."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {diffs.length ? (
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
              {diffs.map((diff) => (
                <li key={diff.metric} className="rounded-lg border border-border px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={diff.type === "add" ? "outline" : "secondary"}>{diff.type === "add" ? "new" : "update"}</Badge>
                    <span className="min-w-0 truncate font-mono" title={diff.metric}>
                      {diff.metric}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground">before</span>
                    <span className={diff.before ? "line-through decoration-muted-foreground/60" : "text-muted-foreground"}>
                      {diff.before ?? "no rule (full resolution)"}
                    </span>
                    <span className="text-muted-foreground">after</span>
                    <span>
                      {diff.after}
                      {diff.addedLabels.length && diff.before ? (
                        <span className="text-brand-ink"> (+{diff.addedLabels.join(", +")})</span>
                      ) : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {review?.errors.length ? (
            <Alert variant="destructive">
              <AlertTitle>Validation failed</AlertTitle>
              <AlertDescription>{review.errors.join("; ")}</AlertDescription>
            </Alert>
          ) : null}
          {review?.result.warnings.length ? <Notes warnings={review.result.warnings} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || !review?.result.changes.length || Boolean(review?.errors.length)}
              onClick={(event) => {
                event.preventDefault()
                void apply()
              }}
            >
              {pending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Apply {review?.result.changes.length ?? 0} changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={revertOpen} onOpenChange={setRevertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert the last apply?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores the {backup?.previous.length ?? 0} Adaptive Metrics rules that were in place before Cardinal applied{" "}
              {backup?.changes ?? 0} changes {formatAgo(backup?.appliedAt) ?? ""}. It only goes ahead if nobody changed the rules since.
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

const FILE_NAMES: Record<Format, string> = {
  prometheus: "cardinal-metric-relabel.yml",
  alloy: "cardinal-relabel.alloy",
  adaptive: "cardinal-adaptive-metrics.json",
}

const TARGET_NAMES: Record<Format, string> = {
  prometheus: "Prometheus metric_relabel_configs",
  alloy: "Grafana Alloy prometheus.relabel",
  adaptive: "Grafana Cloud Adaptive Metrics",
}

/** The active rules a format actually emits (the ones its header and PR description list). */
function emittedRules(rules: Rule[], format: Format) {
  return rules.filter((rule) => {
    if (rule.status !== "active" || isShadowed(rule, rules)) return false
    if (format === "adaptive") return rule.selector.job === undefined && (rule.kind === "drop_metric" || rule.kind === "drop_labels")
    return !(rule.kind === "drop_labels" && rule.impact?.mergesSeries)
  })
}

export function ExportCard({ rules }: { rules: Rule[] }) {
  const snapshot = useAppStore((state) => state.snapshot)
  const drilldowns = useAppStore((state) => state.drilldowns)
  const mode = useAppStore((state) => state.relabelMode)
  const setMode = useAppStore((state) => state.setRelabelMode)
  const cloud = useIsGrafanaCloud()
  const { cost } = useCost()
  const [format, setFormat] = React.useState<Format>(cloud ? "adaptive" : "prometheus")
  const [stage, setStage] = React.useState<PrometheusStage>("scrape")
  // Generation time of what is shown; refreshed whenever the output changes.
  const generatedAt = React.useMemo(() => new Date(), [rules, format, stage, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const plan = React.useMemo(
    () => planRelabel(rules, { mode: stage === "remote_write" ? "combined" : mode, jobsByMetric: snapshot ? jobsByMetric(snapshot) : undefined }),
    [rules, mode, stage, snapshot]
  )
  const adaptive = React.useMemo(() => compileAdaptiveMetrics(rules), [rules])
  const emitted = React.useMemo(() => emittedRules(rules, format), [rules, format])
  const metrics = React.useMemo(() => emitted.map((rule) => rule.selector.metric), [emitted])
  const { summaries } = useUsageSummaries(metrics, emitted.length > 0)

  const context = React.useMemo((): ReportContext => {
    const savings = computeExpectedSavings(emitted, snapshot, drilldowns)
    return {
      generatedAt,
      totalSeries: snapshot?.totalSeries ?? 0,
      savedSeries: savings.savedSeries,
      isEstimate: savings.isEstimate,
      cost,
      formatCost,
      usage: Object.fromEntries(
        Object.entries(summaries).map(([metric, summary]) => [metric, summary.used ? (summary.badge ?? "used") : null])
      ),
    }
  }, [emitted, snapshot, drilldowns, generatedAt, cost, summaries])

  const body =
    format === "prometheus" ? renderPrometheus(plan, stage) : format === "alloy" ? renderAlloy(plan) : renderAdaptiveMetrics(adaptive)
  // JSON has no comments; YAML and Alloy get a header with each rule's rationale and savings.
  const code = format === "adaptive" ? body : `${renderHeader(emitted, context, format === "alloy" ? "//" : "#")}${body}`
  const warnings = format === "adaptive" ? adaptive.warnings : plan.warnings
  const empty = format === "adaptive" ? adaptive.rules.length === 0 : plan.sections.every((section) => section.steps.length === 0)
  const fileName = format === "prometheus" && stage === "remote_write" ? "cardinal-write-relabel.yml" : FILE_NAMES[format]

  const copyPr = async () => {
    const target = format === "prometheus" && stage === "remote_write" ? "Prometheus write_relabel_configs" : TARGET_NAMES[format]
    try {
      await copyText(prDescription(emitted, { ...context, target }))
      toast.success("PR description copied", { description: "Markdown with a rules table and each rule's rationale." })
    } catch {
      toast.error("Could not copy the PR description")
    }
  }

  return (
    <Frame>
      <FrameHeader icon={CodeIcon} title="Export" meta={format === "adaptive" ? "aggregation rules" : "relabel config"} />
      <FrameWell className="flex flex-col gap-3 py-4">
        <SegmentedControl stretch aria-label="Export format" value={format} onValueChange={setFormat} options={FORMAT_OPTIONS} />
        <p className="text-xs text-pretty text-muted-foreground">
          <WhereItRuns format={format} stage={stage} />
        </p>
        {format === "prometheus" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Runs</span>
            <SegmentedControl size="sm" aria-label="Where the rules run" value={stage} onValueChange={setStage} options={STAGE_OPTIONS} />
          </div>
        ) : null}
        {format !== "adaptive" && !(format === "prometheus" && stage === "remote_write") ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Layout</span>
            <SegmentedControl
              size="sm"
              aria-label="Export layout"
              value={mode}
              onValueChange={(value: RelabelMode) => setMode(value)}
              options={LAYOUT_OPTIONS}
            />
          </div>
        ) : null}
        <Notes warnings={warnings} />
        <ImportDiff rules={rules} />
        {empty ? (
          <EmptyState
            compact
            icon={CodeIcon}
            title={rules.length ? "Nothing to export in this format" : "Nothing to export yet"}
            description={
              rules.length
                ? "None of the active rules can ship this way; see the notes above."
                : "Active rules turn into Prometheus relabel config, an Alloy block or Adaptive Metrics rules here."
            }
            className="rounded-2xl border border-dashed border-well-border bg-background/40"
          />
        ) : (
          <>
            {/* Scroll sideways rather than wrapping mid-token, so regexes and label lists stay readable. */}
            <CodeBlock code={code} className="[&_pre]:break-normal [&_pre]:whitespace-pre" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => downloadFile(fileName, code, format === "adaptive" ? "application/json" : "text/plain")}>
                <DownloadSimpleIcon data-icon="inline-start" />
                Download {fileName.slice(fileName.lastIndexOf("."))}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyPr()}>
                <GitPullRequestIcon data-icon="inline-start" />
                Copy PR description
              </Button>
            </div>
            <PasteInstructions format={format} stage={stage} mode={mode} />
          </>
        )}
        {format === "adaptive" && cloud ? <ApplyToGrafanaCloud rules={rules} /> : null}
      </FrameWell>
    </Frame>
  )
}
