import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react"

import { SegmentedControl } from "@/components/segmented-control"
import { Tip } from "@/components/tip"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
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
import { OwnerDot } from "@/features/attribution/owner-badge"
import { useDebounced, useLabelValueSeries } from "@/features/attribution/use-attribution"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { jobLabel } from "@/lib/core/jobs"
import { isLabelName } from "@/lib/core/promql"
import { fullMatch } from "@/lib/core/regex"
import type { Snapshot } from "@/lib/core/snapshot"
import { OWNER_COLORS, ownershipRuleProblem, previewOwnershipRule, type OwnershipRule, type Owner, type RuleOwnership } from "@/lib/core/owner-rules"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

type Kind = OwnershipRule["kind"]

const KIND_OPTIONS = [
  { value: "job", label: "Job", title: "Jobs whose name matches the regex" },
  { value: "metric_prefix", label: "Metric prefix", title: "Metrics whose name starts with a match of the regex" },
  { value: "label", label: "Label", title: "Series whose label value matches the regex (needs a query)" },
] as const

const PLACEHOLDER: Record<Kind, string> = {
  job: "payments-.*",
  metric_prefix: "payments_",
  label: "payments-.*",
}

function switchKind(rule: OwnershipRule, kind: Kind): OwnershipRule {
  if (kind === "label") return { kind, label: rule.kind === "label" ? rule.label : "namespace", pattern: rule.pattern }
  return { kind, pattern: rule.pattern }
}

function Names({ names, total, unit, format = (name) => name }: { names: Array<{ name: string; series: number }>; total: number; unit: string; format?: (name: string) => string }) {
  if (names.length === 0) return <span>Matches nothing in this snapshot.</span>
  const shown = names.slice(0, 4)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="text-foreground">
        {formatNumber(names.length)} {unit}
        {names.length === 1 ? "" : "s"}
      </span>
      <span>· {formatNumber(total)} series:</span>
      {shown.map((item) => (
        <span key={item.name} className="max-w-40 truncate rounded-full bg-background/70 px-1.5 font-mono text-[11px]" title={`${format(item.name)}: ${formatNumber(item.series)} series`}>
          {format(item.name)}
        </span>
      ))}
      {names.length > shown.length ? <span>+{formatNumber(names.length - shown.length)} more</span> : null}
    </span>
  )
}

function LabelPreview({ label, pattern }: { label: string; pattern: string }) {
  const debouncedLabel = useDebounced(label, 400)
  const valid = isLabelName(debouncedLabel) && debouncedLabel !== "__name__"
  const { data, isPending, error } = useLabelValueSeries(valid ? debouncedLabel : null)
  if (!valid) return <span>Enter a label name, e.g. namespace or owner.</span>
  if (isPending) {
    return (
      <span className="flex items-center gap-1.5">
        <Spinner className="size-3" />
        Reading values of {debouncedLabel}…
      </span>
    )
  }
  if (error) return <span className="text-destructive">Could not read {debouncedLabel}: {error.message}</span>
  const values = (data ?? []).filter((item) => item.value !== "")
  if (values.length === 0) return <span>No series have a {debouncedLabel} label.</span>
  const matched = values.filter((item) => fullMatch(pattern, item.value)).map((item) => ({ name: item.value, series: item.seriesCount }))
  return (
    <span className="flex flex-col gap-0.5">
      <Names names={matched} total={matched.reduce((sum, item) => sum + item.series, 0)} unit="value" />
      <span className="text-muted-foreground/80">Among the top {values.length} values of {debouncedLabel}; exact per-metric counts load in the breakdown.</span>
    </span>
  )
}

function RuleRow({
  rule,
  index,
  count,
  snapshot,
  onChange,
  onMove,
  onRemove,
}: {
  rule: OwnershipRule
  index: number
  count: number
  snapshot: Snapshot
  onChange: (rule: OwnershipRule) => void
  onMove: (delta: number) => void
  onRemove: () => void
}) {
  const problem = rule.pattern || rule.kind === "label" ? ownershipRuleProblem(rule) : null
  const preview = React.useMemo(() => (problem ? null : previewOwnershipRule(snapshot, rule)), [snapshot, rule, problem])
  const id = React.useId()

  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-well-border bg-well p-3 [corner-shape:squircle]">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl aria-label="Rule kind" size="sm" value={rule.kind} onValueChange={(kind) => onChange(switchKind(rule, kind))} options={KIND_OPTIONS} />
        <div className="flex items-center">
          <Tip label="Move rule up">
            <Button variant="ghost" size="icon-xs" aria-label="Move rule up" disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUpIcon />
            </Button>
          </Tip>
          <Tip label="Move rule down">
            <Button variant="ghost" size="icon-xs" aria-label="Move rule down" disabled={index === count - 1} onClick={() => onMove(1)}>
              <ArrowDownIcon />
            </Button>
          </Tip>
          <Tip label="Remove rule">
            <Button variant="ghost" size="icon-xs" aria-label="Remove rule" onClick={onRemove}>
              <TrashIcon />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {rule.kind === "label" ? (
          <>
            <Input
              aria-label="Label name"
              value={rule.label}
              onChange={(event) => onChange({ ...rule, label: event.target.value.trim() })}
              placeholder="namespace"
              className="w-32 shrink-0 font-mono text-[13px]"
              spellCheck={false}
            />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">=~</span>
          </>
        ) : (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{rule.kind === "job" ? "job =~" : "^"}</span>
        )}
        <Input
          id={id}
          aria-label="Pattern (RE2 regex)"
          aria-invalid={problem ? true : undefined}
          value={rule.pattern}
          onChange={(event) => onChange({ ...rule, pattern: event.target.value })}
          placeholder={PLACEHOLDER[rule.kind]}
          className="min-w-0 flex-1 font-mono text-[13px]"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="min-h-4 text-xs text-muted-foreground">
        {problem ? (
          <span className="text-destructive">{problem.replace(/^pattern /, "Pattern ")}</span>
        ) : !rule.pattern ? (
          <span>{rule.kind === "metric_prefix" ? "Metrics starting with a match own their series." : "Anchored regex, like Prometheus relabelling."}</span>
        ) : rule.kind === "label" ? (
          <LabelPreview label={rule.label} pattern={rule.pattern} />
        ) : preview ? (
          <Names names={preview.names} total={preview.series} unit={rule.kind === "job" ? "job" : "metric"} format={rule.kind === "job" ? jobLabel : undefined} />
        ) : null}
      </div>
    </li>
  )
}

/** Side sheet that edits one owner in place: name, colour and ownership rules with live previews. */
export function OwnerEditorSheet({
  ownerId,
  onOpenChange,
  snapshot,
  owned,
}: {
  ownerId: string | null
  onOpenChange: (open: boolean) => void
  snapshot: Snapshot
  owned?: RuleOwnership
}) {
  const owner = useAppStore((state) => state.attribution.owners.find((item) => item.id === ownerId))
  const updateOwner = useAppStore((state) => state.updateOwner)
  const removeOwner = useAppStore((state) => state.removeOwner)
  // Keep showing the last owner while the sheet animates closed.
  const [last, setLast] = React.useState<Owner | undefined>(owner)
  if (owner && owner !== last) setLast(owner)
  const shown = owner ?? last

  const setRules = (rules: OwnershipRule[]) => shown && updateOwner(shown.id, { rules })
  const addRule = (kind: Kind) => shown && setRules([...shown.rules, kind === "label" ? { kind, label: "namespace", pattern: "" } : { kind, pattern: "" }])
  const moveRule = (index: number, delta: number) => {
    if (!shown) return
    const rules = [...shown.rules]
    const [rule] = rules.splice(index, 1)
    rules.splice(index + delta, 0, rule)
    setRules(rules)
  }

  return (
    <Sheet open={Boolean(owner)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <OwnerDot color={shown?.color} className="size-2.5" />
            Edit owner
          </SheetTitle>
          <SheetDescription>
            Custom rules apply to series without any attribution label. Owners are checked top to bottom, then their rules in order; the first rule that matches owns the series.
          </SheetDescription>
        </SheetHeader>
        {shown ? (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="owner-name">Name</Label>
              <Input id="owner-name" value={shown.name} maxLength={80} onChange={(event) => updateOwner(shown.id, { name: event.target.value })} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="owner-colour">
                Colour
              </span>
              <div role="radiogroup" aria-labelledby="owner-colour" className="flex flex-wrap gap-1.5">
                {OWNER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={shown.color === color}
                    aria-label={color}
                    onClick={() => updateOwner(shown.id, { color })}
                    className="flex size-7 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
                    style={{ backgroundColor: color }}
                  >
                    {shown.color === color ? <CheckIcon weight="bold" className="size-3.5 text-white" /> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Owner rules</span>
                {owned ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Owns {formatNumber(owned.series)} series ({owned.percent.toFixed(1)}%)
                  </span>
                ) : null}
              </div>
              {shown.rules.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-well-border p-3 text-sm text-muted-foreground">
                  No rules yet: this owner owns nothing. Add a job, metric prefix or label rule.
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {shown.rules.map((rule, index) => (
                    <RuleRow
                      // Rules have no ids; the index is their identity within the list.
                      key={index}
                      rule={rule}
                      index={index}
                      count={shown.rules.length}
                      snapshot={snapshot}
                      onChange={(next) => setRules(shown.rules.map((item, at) => (at === index ? next : item)))}
                      onMove={(delta) => moveRule(index, delta)}
                      onRemove={() => setRules(shown.rules.filter((_, at) => at !== index))}
                    />
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap gap-1.5">
                {KIND_OPTIONS.map((option) => (
                  <Button key={option.value} variant="outline" size="xs" onClick={() => addRule(option.value)}>
                    <PlusIcon data-icon="inline-start" />
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <SheetFooter className="flex-row justify-between border-t border-frame-border">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className={cn("text-destructive hover:text-destructive")} disabled={!owner}>
                <TrashIcon data-icon="inline-start" />
                Delete owner
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {shown?.name}?</AlertDialogTitle>
                <AlertDialogDescription>Its series go to the next matching owner, or to Unattributed.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    if (shown) removeOwner(shown.id)
                    onOpenChange(false)
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
