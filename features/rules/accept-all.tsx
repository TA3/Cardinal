import * as React from "react"
import { CheckIcon, ShieldWarningIcon, WarningIcon } from "@phosphor-icons/react"

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
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { rememberDropConfirmed } from "@/features/explore/drop-scope"
import { DashboardEvidenceLinks } from "@/features/rules/drop-gate"
import { summarizeRule, useUsageEvidence } from "@/features/rules/usage"
import { describeRule } from "@/lib/core/report"
import type { Rule } from "@/lib/core/rules"
import { confirmationKey, guardedLabel, type EvidenceSummary } from "@/lib/core/usage-gate"

/** Confirmation keys for rules a toggle would re-create, so accepted drops don't ask again. */
function confirmationKeys(rules: Rule[]) {
  return rules.flatMap((rule) =>
    rule.kind === "drop_metric"
      ? [confirmationKey(rule.selector.metric, rule.selector.job)]
      : rule.kind === "drop_labels"
        ? rule.labels.map((label) => confirmationKey(rule.selector.metric, rule.selector.job, label))
        : []
  )
}

/**
 * "Accept all" with the usage gate: before the proposals become active it
 * lists the ones whose metric is used somewhere and the guarded labels they
 * drop, and says what wasn't checked.
 */
export function AcceptAllButton({
  rules,
  onAccept,
  trigger,
}: {
  rules: Rule[]
  onAccept: (ids: string[]) => void
  /** Replaces the default "Accept all" button, e.g. a per-row icon button. */
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const metrics = React.useMemo(() => rules.map((rule) => rule.selector.metric), [rules])
  const { byMetric, isPending } = useUsageEvidence(metrics, open)
  // Label drops are judged per label: a dashboard reading the metric doesn't make every label of it used.
  const summaries = React.useMemo(() => {
    const result = new Map<string, EvidenceSummary>()
    for (const rule of rules) {
      const summary = summarizeRule(rule, byMetric[rule.selector.metric])
      if (summary) result.set(rule.id, summary)
    }
    return result
  }, [rules, byMetric])

  const used = rules.filter((rule) => summaries.get(rule.id)?.used)
  const guarded = rules.filter((rule) => rule.kind === "drop_labels" && rule.labels.some((label) => guardedLabel(label)))
  const unchecked = Array.from(new Set(Array.from(summaries.values()).flatMap((summary) => summary.unchecked)))
  const checked = Array.from(new Set(Array.from(summaries.values()).flatMap((summary) => summary.checked)))
  const flagged = new Set([...used, ...guarded])
  const unused = rules.filter((rule) => !flagged.has(rule))

  const accept = (list: Rule[]) => {
    rememberDropConfirmed(...confirmationKeys(list))
    onAccept(list.map((rule) => rule.id))
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
              ? "Checking where these metrics are used…"
              : flagged.size
                ? `${flagged.size} of them touch something in use. Review before they become active.`
                : "None of them is referenced by anything Cardinal could check."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Reading alerting rules and usage…
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
                  {used.map((rule) => {
                    const summary = summaries.get(rule.id)
                    const labels = rule.kind === "drop_labels" ? rule.labels : [undefined]
                    return (
                      <li key={rule.id} className="flex flex-col gap-1 text-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="min-w-0 font-medium break-all">{describeRule(rule)}</span>
                          <span className="text-muted-foreground">{summary?.badge}</span>
                        </div>
                        {summary?.found.length ? (
                          <ul className="flex flex-col gap-0.5 text-muted-foreground">
                            {summary.found.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        ) : null}
                        {labels.map((label) => (
                          <DashboardEvidenceLinks key={label ?? "metric"} evidence={byMetric[rule.selector.metric]} label={label} />
                        ))}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
            {guarded.length ? (
              <section className="flex flex-col gap-1">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <ShieldWarningIcon className="size-3.5" aria-hidden />
                  Drops a guarded label
                </h3>
                <ul className="flex flex-col gap-1 text-xs">
                  {guarded.map((rule) => (
                    <li key={rule.id}>
                      <span className="break-all">{describeRule(rule)}</span>
                      {rule.kind === "drop_labels"
                        ? rule.labels
                            .map((label) => guardedLabel(label))
                            .filter((guard) => guard !== undefined)
                            .map((guard) => (
                              <span key={guard.title} className="block text-muted-foreground">
                                {guard.title}. {guard.reason}
                              </span>
                            ))
                        : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {checked.length || unchecked.length ? (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {[...checked.map((line) => `Checked ${line}`), ...unchecked].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {flagged.size && unused.length ? (
            <Button variant="outline" disabled={isPending} onClick={() => accept(unused)}>
              Accept the {unused.length} unflagged
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
