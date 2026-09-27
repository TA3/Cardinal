import * as React from "react"
import { ArrowCounterClockwiseIcon, DatabaseIcon, EraserIcon, PercentIcon, ProhibitIcon, ScissorsIcon, ShieldCheckIcon, type Icon } from "@phosphor-icons/react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isDropConfirmed, rememberDropConfirmed } from "@/features/explore/drop-scope"
import { logConfirmKey, LogRuleGate, selectorText, type GateChoice, type LogToggleCandidate, type LogToggleKind } from "@/features/logs/log-rule-gate"
import { guardedLogLabel } from "@/lib/core/logs/label-advice"
import { logRuleKey, logRuleProblem, type LogRuleInput } from "@/lib/core/logs/rules"
import { selectorKey } from "@/lib/core/logs/selector"
import type { LineFilter, LogRule, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const SIZES = {
  lg: "h-8 gap-1.5 px-3 text-sm [&_svg]:size-4",
  default: "h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
  xs: "h-6 gap-1 px-2 text-[11px] [&_svg]:size-3",
  icon: "size-7 justify-center [&_svg]:size-3.5",
  /** Icon-only on phones, labelled from `sm` up. */
  responsive: "size-7 justify-center text-xs sm:w-auto sm:gap-1.5 sm:px-2.5 [&_svg]:size-3.5",
} as const

const KIND: Record<LogToggleKind, { icon: Icon; idle: string; verb: string; soft?: boolean }> = {
  drop_streams: { icon: ProhibitIcon, idle: "Drop", verb: "Drop these streams" },
  drop_label: { icon: EraserIcon, idle: "Drop label", verb: "Drop the label" },
  label_to_metadata: { icon: DatabaseIcon, idle: "To metadata", verb: "Move the label to structured metadata", soft: true },
  sample: { icon: PercentIcon, idle: "Sample", verb: "Sample these lines" },
  drop_lines: { icon: ScissorsIcon, idle: "Drop lines", verb: "Drop lines" },
  keep: { icon: ShieldCheckIcon, idle: "Protect", verb: "Protect these lines from drops", soft: true },
}

function percent(keep: number) {
  const value = keep * 100
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function activeText(rule: LogRule) {
  switch (rule.kind) {
    case "drop_streams":
      return "Dropped"
    case "drop_label":
      return "Label dropped"
    case "label_to_metadata":
      return "Metadata"
    case "sample":
      return `Keep ${percent(rule.keep)}`
    case "drop_lines":
      return rule.line.levels?.length ? `No ${rule.line.levels.join(", ")}` : "Lines dropped"
    case "keep":
      return "Protected"
    default:
      return "Active"
  }
}

/** The rule input for a candidate plus the gate's choice; placeholders stand in for a choice not made yet. */
function toInput(candidate: LogToggleCandidate, choice: GateChoice = {}): LogRuleInput {
  const rationale = choice.rationale ?? candidate.rationale
  const base = {
    selector: candidate.selector,
    origin: "user" as const,
    ...(rationale ? { rationale } : {}),
  }
  switch (candidate.kind) {
    case "drop_streams":
      return { ...base, kind: "drop_streams" }
    case "drop_label":
      return { ...base, kind: "drop_label", label: candidate.label ?? "" }
    case "label_to_metadata":
      return { ...base, kind: "label_to_metadata", label: candidate.label ?? "" }
    case "sample": {
      const line = choice.line ?? candidate.line
      return { ...base, kind: "sample", keep: choice.keep ?? 0.1, ...(line ? { line } : {}) }
    }
    case "drop_lines":
      return { ...base, kind: "drop_lines", line: choice.line ?? candidate.line ?? { levels: ["debug", "trace"] } }
    case "keep": {
      const line = choice.line ?? candidate.line
      // A placeholder reason until the gate asks for one, so the rule's other problems still show.
      return { ...base, kind: "keep", rationale: rationale ?? "…", ...(line ? { line } : {}) }
    }
  }
}

/** The active rule this toggle stands for: same key, or for "Drop lines…" without a preset filter any drop_lines on the selector. */
export function findActiveLogRule(rules: LogRule[], candidate: LogToggleCandidate): LogRule | undefined {
  if (candidate.kind === "drop_lines" && !candidate.line) {
    const key = selectorKey(candidate.selector)
    return rules.find((rule) => rule.status === "active" && rule.kind === "drop_lines" && selectorKey(rule.selector) === key)
  }
  let key: string
  try {
    key = logRuleKey(toInput(candidate))
  } catch {
    return undefined
  }
  return rules.find((rule) => rule.status === "active" && logRuleKey(rule) === key)
}

/**
 * The one control for log rules, modelled on DropToggle: an outline pill that
 * turns into a crimson active pill (brand for a metadata move) with an undo
 * affordance. It reads and writes `store.logRules`. Before a rule becomes
 * active a popover shows where the streams are read (Loki rules, LogQL
 * dashboards) and what wasn't checked; sampling and "Drop lines…" pick their
 * rate or filter there. Guarded labels always ask and need an override.
 */
export function LogRuleToggle({
  kind,
  selector,
  label,
  line,
  rationale,
  hint,
  size = "default",
  reveal = false,
  disabled = false,
  className,
}: {
  kind: LogToggleKind
  /** Empty matchers: every stream. */
  selector: StreamSelector
  label?: string
  /** Preset line filter for sample / drop_lines / keep (e.g. from a pattern). */
  line?: LineFilter
  /** The rule's rationale (a keep asks for one when it's missing). */
  rationale?: string
  /** What the rule changes, shown in the gate (e.g. "−120 streams"). */
  hint?: React.ReactNode
  size?: keyof typeof SIZES
  /** In table rows: hidden until the row is hovered or focused (pointer devices only). */
  reveal?: boolean
  disabled?: boolean
  className?: string
}) {
  const candidate = React.useMemo<LogToggleCandidate>(() => ({ kind, selector, label, line, rationale }), [kind, selector, label, line, rationale])
  const rules = useAppStore((state) => state.logRules)
  const active = React.useMemo(() => findActiveLogRule(rules, candidate), [rules, candidate])
  const problem = React.useMemo(() => logRuleProblem(toInput(candidate)), [candidate])
  const [gateOpen, setGateOpen] = React.useState(false)
  const meta = KIND[kind]
  const IconComponent = meta.icon
  const on = Boolean(active)
  const scope = selectorText(selector)
  const name = label ?? scope
  const hintText = on
    ? `Active: ${activeText(active!)} for ${scope}. Click to remove the rule.`
    : problem
      ? `Can't: ${problem}`
      : `${meta.verb}${label ? ` ${label}` : ""} for ${scope}`
  const needsChoice = kind === "sample" || (kind === "drop_lines" && !line) || (kind === "keep" && !rationale)
  const guarded = (kind === "drop_label" || kind === "label_to_metadata") && Boolean(guardedLogLabel(label))

  const apply = (choice: GateChoice) => {
    const { activateLogRule } = useAppStore.getState()
    try {
      activateLogRule(toInput(candidate, choice))
    } catch (error) {
      toast.error("Couldn't add the rule", { description: error instanceof Error ? error.message : String(error) })
    }
  }
  const remove = () => {
    const { toggleLogRule } = useAppStore.getState()
    if (!active) return
    try {
      toggleLogRule(active as LogRuleInput)
    } catch (error) {
      toast.error("Couldn't remove the rule", { description: error instanceof Error ? error.message : String(error) })
    }
  }
  const confirm = (choice: GateChoice) => {
    rememberDropConfirmed(logConfirmKey(candidate))
    setGateOpen(false)
    apply(choice)
  }
  const blocked = !on && Boolean(problem)
  const onClick = () => {
    if (blocked) toast.info("This rule can't be added", { description: problem })
    else if (on) remove()
    else if (!needsChoice && !guarded && isDropConfirmed(logConfirmKey(candidate))) apply({})
    else setGateOpen(true)
  }
  const soft = meta.soft === true

  return (
    <Popover open={gateOpen} onOpenChange={setGateOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverAnchor asChild>
            <button
              type="button"
              aria-pressed={on}
              aria-label={`${on ? "Undo" : meta.idle} ${name}: ${hintText}`}
              aria-haspopup="dialog"
              aria-expanded={gateOpen}
              disabled={disabled}
              aria-disabled={blocked || undefined}
              data-reveal={(reveal && !gateOpen) || undefined}
              onClick={(event) => {
                event.stopPropagation()
                onClick()
              }}
              className={cn(
                "nodrag group/drop inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,scale] duration-200 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 aria-disabled:opacity-40 aria-disabled:active:scale-100",
                on
                  ? soft
                    ? "border-brand/30 bg-brand/10 text-brand-ink hover:bg-brand/15 dark:bg-brand/20"
                    : "border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/20"
                  : cn(
                      "border-border bg-background text-muted-foreground dark:border-input dark:bg-input/30",
                      soft ? "hover:border-brand/40 hover:text-brand-ink" : "hover:border-destructive/30 hover:text-destructive"
                    ),
                SIZES[size],
                className
              )}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={on ? "on" : "off"}
                  initial={{ opacity: 0, scale: 0.6, rotate: -45 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={{ opacity: 0, scale: 0.6, rotate: 45 }}
                  transition={{ type: "spring", bounce: 0.35, duration: 0.35 }}
                  className="flex"
                >
                  <IconComponent weight={on ? "bold" : "regular"} />
                </motion.span>
              </AnimatePresence>
              {size === "icon" ? null : (
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={on ? `on:${activeText(active!)}` : "off"}
                    initial={{ opacity: 0, filter: "blur(2px)", y: 3 }}
                    animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                    exit={{ opacity: 0, filter: "blur(2px)", y: -3 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className={cn("flex items-center gap-1", size === "responsive" && "hidden sm:flex")}
                  >
                    {on ? activeText(active!) : `${meta.idle}${needsChoice ? "…" : ""}`}
                    {on ? (
                      <ArrowCounterClockwiseIcon aria-hidden className="opacity-50 transition-opacity group-hover/drop:opacity-100" />
                    ) : null}
                  </motion.span>
                </AnimatePresence>
              )}
            </button>
          </PopoverAnchor>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{hintText}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="w-[min(22rem,calc(100vw-2rem))]"
        onClick={(event) => event.stopPropagation()}
        aria-label={`Confirm: ${meta.verb}`}
      >
        {gateOpen ? <LogRuleGate candidate={candidate} hint={hint} onConfirm={confirm} onCancel={() => setGateOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  )
}
