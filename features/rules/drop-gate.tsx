import * as React from "react"
import { CheckCircleIcon, EyeSlashIcon, MagnifyingGlassIcon, ShieldWarningIcon, StackIcon, WarningIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { metricPath } from "@/app/paths"
import { InfoTip } from "@/components/info-tip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { scopeText } from "@/features/explore/drop-scope"
import { CHOICE_LABEL, MergeChoiceControl, MergePreview, useLabelDropImpact, type MergeDecision } from "@/features/rules/merge-choice"
import { Term } from "@/features/rules/term"
import { useUsageEvidence } from "@/features/rules/usage"
import { DashboardUsageList } from "@/features/usage/dashboard-usage-list"
import { labelEvidence } from "@/lib/core/grafana-usage"
import { guardedLabel, orphanWarning, summarizeEvidence, type EvidenceSummary, type UsageEvidence } from "@/lib/core/usage-gate"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

/** Found evidence, clean checks, what was checked and what wasn't, as the gate and "Accept all" show it. */
export function EvidenceList({
  summary,
  pending,
  compact = false,
  className,
}: {
  summary: EvidenceSummary | null
  pending?: boolean
  /** Only what was found; clean checks and what wasn't checked go behind a "Why?". */
  compact?: boolean
  className?: string
}) {
  if (pending || !summary) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <Spinner />
        Checking where it's used…
      </div>
    )
  }
  const lines = (items: string[], Icon: React.ComponentType<{ className?: string }>, iconClass: string, textClass?: string) =>
    items.length ? (
      <ul className={cn("flex flex-col gap-1", textClass)}>
        {items.map((line) => (
          <li key={line} className="flex gap-1.5">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", iconClass)} aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    ) : null
  if (compact) {
    const details = [...summary.clear, ...summary.checked, ...summary.unchecked]
    const found = summary.found.length > 0
    return (
      <div className={cn("flex flex-col gap-1.5 text-xs", className)}>
        {lines(summary.found, WarningIcon, "text-brand-ink")}
        <p className="flex items-center gap-1 text-muted-foreground">
          {found ? (
            "Sources checked"
          ) : summary.used ? (
            "Used"
          ) : (
            <Badge variant="outline" data-slot="unused-chip" className="text-muted-foreground">
              {summary.unchecked.length ? "Not found in use" : "Unused"}
            </Badge>
          )}
          {details.length ? (
            <InfoTip label="What was checked">
              <ul className="flex flex-col gap-1">
                {details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </InfoTip>
          ) : null}
        </p>
      </div>
    )
  }
  return (
    <div className={cn("flex flex-col gap-1.5 text-xs", className)}>
      {lines(summary.found, WarningIcon, "text-brand-ink")}
      {lines(summary.clear, CheckCircleIcon, "text-muted-foreground")}
      {lines(summary.checked, MagnifyingGlassIcon, "", "text-muted-foreground")}
      {lines(summary.unchecked, EyeSlashIcon, "", "text-muted-foreground")}
    </div>
  )
}

/** The panels and alerts behind the evidence: all of them for a metric, those using the label for a label. */
export function DashboardEvidenceLinks({ evidence, label, className }: { evidence: UsageEvidence | undefined; label?: string; className?: string }) {
  const usages = evidence?.dashboards?.usages
  const relevant = React.useMemo(() => (!usages ? [] : label === undefined ? usages : labelEvidence(usages, label).used), [usages, label])
  if (!relevant.length) return null
  return <DashboardUsageList usages={relevant} label={label} maxGroups={3} maxPanels={4} className={className} />
}

/**
 * The check before a drop becomes active: usage evidence, guarded labels (with
 * an explicit override) and, for `_bucket` metrics, the histogram parts the
 * drop would orphan.
 */
export function DropGate({
  metric,
  label,
  targetJob,
  onConfirm,
  onDropFamily,
  onCancel,
}: {
  metric: string
  label?: string
  /** The job the new rule applies to; undefined is every job. */
  targetJob?: string
  /** For a label drop that merges series, what to do about the merge. */
  onConfirm: (merge?: MergeDecision) => void
  onDropFamily?: (members: string[]) => void
  onCancel: () => void
}) {
  const snapshot = useAppStore((state) => state.snapshot)
  const { byMetric, isPending } = useUsageEvidence([metric])
  const evidence = byMetric[metric]
  const summary = React.useMemo(() => (evidence ? summarizeEvidence(evidence, label) : null), [evidence, label])
  const guard = guardedLabel(label)
  const orphans = label === undefined ? orphanWarning(metric, snapshot) : null
  const [override, setOverride] = React.useState(false)
  const overrideId = React.useId()
  // A label drop that merges series asks what to do; unused labels default to dropping anyway.
  const impact = useLabelDropImpact(metric, label ?? "", label !== undefined && !guard, targetJob)
  const merges = Boolean(impact.data?.mergesSeries)
  const [picked, setPicked] = React.useState<MergeDecision | null>(null)
  const decision: MergeDecision = picked ?? { choice: summary && !summary.used ? "drop" : null }
  const needsChoice = merges && !decision.choice

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">
          Drop {label !== undefined ? <code className="font-mono text-[13px]">{label}</code> : null}
          {label !== undefined ? " from " : null}
          <code className="font-mono text-[13px] break-all">{metric}</code>?
        </p>
        <p className="text-xs text-muted-foreground">Applies to {scopeText(targetJob)}.</p>
      </div>

      {guard ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <ShieldWarningIcon className="size-4" aria-hidden />
            {guard.title}
          </p>
          <p>
            {guard.reason}
            {label === "le" ? (
              <>
                {" "}
                See <Term id="histogramBuckets">histogram buckets</Term>.
              </>
            ) : null}
          </p>
          {label === "le" ? (
            <Button asChild size="xs" variant="outline" className="self-start">
              <Link to={`${metricPath(metric)}?label=le`} onClick={onCancel}>
                Keep only some buckets instead
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      {orphans ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-brand/30 bg-brand/5 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-brand-ink">
            <StackIcon className="size-4" aria-hidden />
            Leaves {orphans.orphans.map((name) => name.slice(orphans.base.length)).join(" and ")} orphaned
          </p>
          <p>
            Without the buckets, {orphans.orphans.map((name) => name.slice(orphans.base.length)).join(" and ")} only give an average;
            quantiles and heatmaps stop working. Drop the whole histogram if nothing reads it.
          </p>
          {onDropFamily ? (
            <Button size="xs" variant="outline" className="self-start" onClick={() => onDropFamily(orphans.members)}>
              Drop the whole family ({orphans.members.length} metrics)
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Long evidence scrolls inside the popover instead of pushing it off screen. */}
      <div className="-mx-1 flex max-h-[max(10rem,calc(var(--radix-popover-content-available-height,100vh)-11rem))] min-h-0 flex-col gap-3 overflow-y-auto px-1">
        {label !== undefined && merges && impact.data ? (
          <div className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-brand/5 p-2.5">
            <MergePreview metric={metric} job={targetJob} labels={[label]} before={impact.data.seriesBefore} after={impact.data.seriesAfter} />
            <MergeChoiceControl
              metric={metric}
              job={targetJob}
              labels={[label]}
              decision={decision}
              onChange={setPicked}
              defaulted={!picked && decision.choice !== null}
            />
          </div>
        ) : null}
        <EvidenceList summary={summary} pending={isPending} compact />
        {isPending ? null : <DashboardEvidenceLinks evidence={evidence} label={label} className="rounded-lg border bg-muted/30 p-2.5" />}
      </div>

      {guard ? (
        <div className="flex items-center gap-2">
          <Checkbox id={overrideId} checked={override} onCheckedChange={(value) => setOverride(value === true)} />
          <Label htmlFor={overrideId} className="text-xs font-normal">
            I understand; drop <code className="font-mono">{label}</code> anyway
          </Label>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={(Boolean(guard) && !override) || needsChoice}
          onClick={() => onConfirm(merges ? decision : undefined)}
          autoFocus={!guard}
        >
          {merges && decision.choice ? CHOICE_LABEL[decision.choice] : summary?.used ? "Drop anyway" : "Drop"}
        </Button>
      </div>
    </div>
  )
}
