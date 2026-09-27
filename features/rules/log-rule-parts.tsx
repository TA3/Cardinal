import * as React from "react"
import { CheckIcon, RobotIcon, ShieldCheckIcon, ShieldWarningIcon, SparkleIcon, TrashIcon, UploadSimpleIcon, UserIcon, WarningIcon, XIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { CostText } from "@/components/cost-text"
import { Tip } from "@/components/tip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { rememberDropConfirmed } from "@/features/explore/drop-scope"
import { logConfirmKey, type LogToggleKind } from "@/features/logs/log-rule-gate"
import { groupLink } from "@/features/logs/streams-shared"
import { useLogUsageSummaries } from "@/features/rules/log-usage"
import { formatBytes } from "@/lib/core/bytes"
import { isAdaptiveLogsRecommendation } from "@/lib/core/logs/adaptive-apply"
import { describeLogRule } from "@/lib/core/logs/rules"
import { renderSelector } from "@/lib/core/logs/selector"
import type { LogRule } from "@/lib/core/logs/types"
import { formatAgo } from "@/lib/core/report"
import { useAppStore } from "@/lib/store/app-store"

// Rules-page pieces for log rules, the logs twins of components/rule-parts.tsx.

const KIND_LABEL: Record<LogRule["kind"], string> = {
  drop_streams: "Drop streams",
  drop_lines: "Drop lines",
  sample: "Sample",
  drop_label: "Drop label",
  label_to_metadata: "To metadata",
  retention: "Retention",
  keep: "Keep",
}

export function LogRuleOriginBadge({ rule }: { rule: LogRule }) {
  if (rule.origin === "agent") {
    return (
      <Badge variant="secondary">
        <RobotIcon data-icon="inline-start" />
        Agent
      </Badge>
    )
  }
  if (isAdaptiveLogsRecommendation(rule)) {
    return (
      <Badge variant="secondary">
        <SparkleIcon data-icon="inline-start" />
        Adaptive
      </Badge>
    )
  }
  if (rule.origin === "import") {
    return (
      <Badge variant="outline">
        <UploadSimpleIcon data-icon="inline-start" />
        Imported
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <UserIcon data-icon="inline-start" />
      You
    </Badge>
  )
}

function selectorText(rule: LogRule) {
  if (rule.selector.matchers.length === 0) return "all streams"
  try {
    return renderSelector(rule.selector)
  } catch {
    return "(invalid selector)"
  }
}

function KindBadges({ rule }: { rule: LogRule }) {
  const kind = (
    <Badge
      variant={rule.kind === "drop_streams" ? "destructive" : "outline"}
      className={rule.kind === "keep" ? "border-brand/40 text-brand-ink" : undefined}
      key="kind"
    >
      {rule.kind === "keep" ? <ShieldCheckIcon data-icon="inline-start" /> : null}
      {KIND_LABEL[rule.kind]}
    </Badge>
  )
  switch (rule.kind) {
    case "drop_lines":
    case "sample":
    case "keep": {
      const line = rule.line
      const text = line?.levels?.length ? `level ${line.levels.join(", ")}` : line?.regex ? `/${line.regex}/` : null
      return (
        <>
          {kind}
          {rule.kind === "sample" ? <Badge variant="outline" className="tabular-nums">keep {Math.round(rule.keep * 1000) / 10}%</Badge> : null}
          {text ? (
            <Badge variant="outline" className="max-w-full font-mono" title={text}>
              <span className="truncate">{text}</span>
            </Badge>
          ) : null}
        </>
      )
    }
    case "drop_label":
    case "label_to_metadata":
      return (
        <>
          {kind}
          <Badge variant="outline" className="font-mono">
            {rule.kind === "drop_label" ? "−" : "→"}
            {rule.label}
          </Badge>
        </>
      )
    case "retention":
      return (
        <>
          {kind}
          <Badge variant="outline" className="tabular-nums">
            {rule.days} day{rule.days === 1 ? "" : "s"}
          </Badge>
        </>
      )
    default:
      return kind
  }
}

export function LogRuleDescription({ rule, supersededBy, protectedBy }: { rule: LogRule; supersededBy?: LogRule; protectedBy?: LogRule }) {
  // A rule on one stream group links to it, like metric rules link to their metric.
  const only = rule.selector.matchers.length === 1 ? rule.selector.matchers[0] : undefined
  const group = only?.op === "=" && only.value ? only : undefined
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {group ? (
        <Link to={groupLink(group.value, group.label)} className="font-mono text-sm break-all hover:underline" title={describeLogRule(rule)}>
          {selectorText(rule)}
        </Link>
      ) : (
        <span className="font-mono text-sm break-all" title={describeLogRule(rule)}>
          {selectorText(rule)}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <KindBadges rule={rule} />
        {supersededBy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" tabIndex={0}>
                superseded
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {`"${describeLogRule(supersededBy)}" already covers these lines, so this rule changes nothing. It isn't exported or counted.`}
            </TooltipContent>
          </Tooltip>
        ) : protectedBy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" tabIndex={0}>
                protected
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {`Keep rule "${describeLogRule(protectedBy)}" protects every line this rule would remove, so it changes nothing. It isn't exported or counted.`}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/** Bytes a rule saves per day and the streams it removes, from its impact over the snapshot range. */
export function LogRuleImpactCell({ rule, rangeDays, totalBytes }: { rule: LogRule; rangeDays: number; totalBytes: number }) {
  const impact = rule.impact
  if (!impact) return <span className="text-xs text-muted-foreground">{rule.status === "rejected" ? "–" : "Not measured"}</span>
  const saved = Math.max(0, impact.bytesBefore - impact.bytesAfter)
  const perDay = saved / Math.max(rangeDays, 1 / 24)
  const streams = impact.streamsBefore !== undefined && impact.streamsAfter !== undefined ? Math.max(0, impact.streamsBefore - impact.streamsAfter) : 0
  const approx = impact.exact ? "" : "~"
  const ago = formatAgo(impact.measuredAt)
  const snapshotDerived = rule.kind === "drop_streams" && rule.selector.matchers.length === 1
  return (
    <div className="flex flex-col items-end" title={impact.note}>
      {saved > 0 ? (
        <span className="text-sm tabular-nums">
          {approx}
          {formatBytes(perDay)}
          <span className="text-muted-foreground">/day</span>
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">
          {rule.kind === "retention" ? "storage only" : rule.kind === "keep" ? `keeps ${formatBytes(impact.bytesBefore / Math.max(rangeDays, 1 / 24))}/day` : "0 B"}
        </span>
      )}
      {saved > 0 && totalBytes > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">{((saved / totalBytes) * 100).toFixed(2)}%</span>
      ) : null}
      {streams > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {approx}−{streams.toLocaleString()} streams
        </span>
      ) : null}
      {saved > 0 ? <CostText bytes={perDay} per="day" /> : null}
      {ago ? (
        <span className="text-[11px] text-muted-foreground/80" title={new Date(impact.measuredAt).toLocaleString()}>
          {snapshotDerived ? "snapshot" : "measured"} {ago}
        </span>
      ) : null}
    </div>
  )
}

/**
 * "Accept all" for log proposals with the usage gate, like the metrics
 * AcceptAllButton: before they become active it lists the ones Loki rules or
 * LogQL dashboards read and those that drop whole streams, and says what was
 * and wasn't checked.
 */
export function LogAcceptAllButton({ rules, trigger }: { rules: LogRule[]; trigger?: React.ReactNode }) {
  const setLogRuleStatus = useAppStore((state) => state.setLogRuleStatus)
  const [open, setOpen] = React.useState(false)
  const { summaries, isPending } = useLogUsageSummaries(rules, open)
  const used = rules.filter((rule) => summaries[rule.id]?.used)
  const streams = rules.filter((rule) => rule.kind === "drop_streams" && !summaries[rule.id]?.used)
  const flagged = new Set([...used, ...streams])
  const unflagged = rules.filter((rule) => !flagged.has(rule))
  const unchecked = Array.from(new Set(Object.values(summaries).flatMap((summary) => summary.unchecked)))
  const checked = Array.from(new Set(Object.values(summaries).flatMap((summary) => summary.checked)))

  const accept = (list: LogRule[]) => {
    // Accepted rules don't ask again when their toggle is used later.
    rememberDropConfirmed(...list.map((rule) => logConfirmKey({ kind: rule.kind as LogToggleKind, selector: rule.selector, label: "label" in rule ? rule.label : undefined })))
    setLogRuleStatus(
      list.map((rule) => rule.id),
      "active"
    )
    setOpen(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <CheckIcon data-icon="inline-start" />
            Accept all
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{rules.length === 1 ? "Accept this proposal?" : `Accept ${rules.length} proposals?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {isPending
              ? "Checking where these streams are read…"
              : flagged.size
                ? `${flagged.size} of them touch something in use or drop whole streams. Review before they become active.`
                : "None of them cuts anything Cardinal could find in use."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Reading Loki rules and the LogQL scan…
          </div>
        ) : (
          <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto text-sm">
            {used.length ? (
              <section className="flex flex-col gap-1">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-brand-ink">
                  <WarningIcon className="size-3.5" aria-hidden />
                  Used
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {used.map((rule) => (
                    <li key={rule.id} className="flex flex-col gap-1 text-xs">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="min-w-0 font-medium break-all">{describeLogRule(rule)}</span>
                        <span className="text-muted-foreground">{summaries[rule.id]?.badge}</span>
                      </div>
                      <ul className="flex flex-col gap-0.5 text-muted-foreground">
                        {summaries[rule.id]?.found.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {streams.length ? (
              <section className="flex flex-col gap-1">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <ShieldWarningIcon className="size-3.5" aria-hidden />
                  Drops whole streams
                </h3>
                <ul className="flex flex-col gap-1 text-xs">
                  {streams.map((rule) => (
                    <li key={rule.id} className="break-all">
                      {describeLogRule(rule)}
                      {rule.impact ? <span className="text-muted-foreground"> · {formatBytes(rule.impact.bytesBefore)} in the snapshot range</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {checked.length || unchecked.length ? (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {[...checked, ...unchecked].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {flagged.size && unflagged.length ? (
            <Button variant="outline" disabled={isPending} onClick={() => accept(unflagged)}>
              Accept the {unflagged.length} unflagged
            </Button>
          ) : null}
          <AlertDialogAction
            disabled={isPending}
            variant={flagged.size ? "destructive" : "default"}
            onClick={(event) => {
              event.preventDefault()
              accept(rules)
            }}
          >
            {flagged.size ? `Accept all ${rules.length} anyway` : `Accept all ${rules.length}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function LogRuleActions({ rule }: { rule: LogRule }) {
  const setLogRuleStatus = useAppStore((state) => state.setLogRuleStatus)
  const removeLogRule = useAppStore((state) => state.removeLogRule)
  if (rule.status === "proposed") {
    return (
      <div className="flex justify-end gap-1">
        <Tip label="Reject proposal">
          <Button size="icon-sm" variant="ghost" aria-label="Reject" onClick={() => setLogRuleStatus([rule.id], "rejected")}>
            <XIcon />
          </Button>
        </Tip>
        <LogAcceptAllButton
          rules={[rule]}
          trigger={
            <Button size="icon-sm" variant="outline" aria-label="Accept">
              <CheckIcon />
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className="flex justify-end gap-1">
      {rule.status === "rejected" ? (
        <Button size="xs" variant="ghost" onClick={() => setLogRuleStatus([rule.id], "proposed")}>
          Restore
        </Button>
      ) : null}
      <Tip label="Remove rule">
        <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => removeLogRule(rule.id)}>
          <TrashIcon />
        </Button>
      </Tip>
    </div>
  )
}
