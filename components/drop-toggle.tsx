import * as React from "react"
import { ArrowCounterClockwiseIcon, ProhibitIcon } from "@phosphor-icons/react"
import { AnimatePresence, motion } from "motion/react"

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  dropHint,
  isDropConfirmed,
  rememberDropConfirmed,
  targetJob,
  toggleLabelDrop,
  toggleMetricDrop,
  type DropScope,
} from "@/features/explore/drop-scope"
import { DropGate } from "@/features/rules/drop-gate"
import { confirmationKey, guardedLabel } from "@/lib/core/usage-gate"
import { labelDropRule, metricDropRule, useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const SIZES = {
  lg: "h-8 gap-1.5 px-3 text-sm [&_svg]:size-4",
  default: "h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
  xs: "h-6 gap-1 px-2 text-[11px] [&_svg]:size-3",
  icon: "size-7 justify-center [&_svg]:size-3.5",
  /** Icon-only on phones, labelled from `sm` up. */
  responsive: "size-7 justify-center text-xs sm:w-auto sm:gap-1.5 sm:px-2.5 [&_svg]:size-3.5",
} as const

/**
 * The one Drop control: an outline pill that turns into a crimson "Dropped"
 * pill with an undo affordance. Scope follows drop-scope: a rule that applies
 * here is removed, otherwise one is added for `scope` (the view's job, or all).
 * Before a drop becomes active a popover shows where the metric is used (the
 * usage gate); once confirmed, the same drop toggles without asking again.
 */
export function DropToggle({
  metric,
  label,
  job,
  scope = "job",
  size = "default",
  reveal = false,
  disabled = false,
  className,
}: {
  metric: string
  /** Drops this label of the metric instead of the whole metric. */
  label?: string
  /** The job whose view this is; undefined is the all-jobs view. */
  job?: string
  scope?: DropScope
  size?: keyof typeof SIZES
  /** In table rows: hidden until the row is hovered or focused (pointer devices only). */
  reveal?: boolean
  disabled?: boolean
  className?: string
}) {
  const rules = useAppStore((state) => state.rules)
  const rule = label === undefined ? metricDropRule(rules, metric, job) : labelDropRule(rules, metric, label, job)
  const dropped = Boolean(rule)
  const hint = dropHint(label === undefined ? "metric" : "label", rule ? rule.selector.job : null, targetJob(job, scope))
  // In a job's view, a rule from the all-jobs view is marked as such.
  const global = dropped && job !== undefined && rule?.selector.job === undefined
  const name = label ?? metric

  const [gateOpen, setGateOpen] = React.useState(false)
  const newJob = targetJob(job, scope)
  const gateKey = confirmationKey(metric, newJob, label)

  const toggle = () => (label === undefined ? toggleMetricDrop(metric, job, scope) : toggleLabelDrop(metric, label, job, scope))
  const confirm = () => {
    rememberDropConfirmed(gateKey)
    setGateOpen(false)
    toggle()
  }
  const dropFamily = (members: string[]) => {
    const { rules } = useAppStore.getState()
    const keys: string[] = []
    for (const member of members) {
      keys.push(confirmationKey(member, newJob))
      if (!metricDropRule(rules, member, job)) toggleMetricDrop(member, job, scope)
    }
    rememberDropConfirmed(...keys)
    setGateOpen(false)
  }
  const onClick = () => {
    // Keeping (removing the rule), or a drop confirmed before (guarded labels always ask).
    if (dropped || (!guardedLabel(label) && isDropConfirmed(gateKey))) toggle()
    else setGateOpen(true)
  }

  return (
    <Popover open={gateOpen} onOpenChange={setGateOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverAnchor asChild>
            <button
              type="button"
              aria-pressed={dropped}
              aria-label={`${dropped ? "Keep" : "Drop"} ${name}: ${hint}`}
              aria-haspopup="dialog"
              aria-expanded={gateOpen}
              disabled={disabled}
              data-reveal={(reveal && !gateOpen) || undefined}
              onClick={(event) => {
                event.stopPropagation()
                onClick()
              }}
              className={cn(
                "nodrag group/drop inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,scale] duration-200 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40",
                dropped
                  ? "border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/20"
                  : "border-border bg-background text-muted-foreground hover:border-destructive/30 hover:text-destructive dark:border-input dark:bg-input/30",
                SIZES[size],
                className
              )}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={dropped ? "on" : "off"}
                  initial={{ opacity: 0, scale: 0.6, rotate: -45 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={{ opacity: 0, scale: 0.6, rotate: 45 }}
                  transition={{ type: "spring", bounce: 0.35, duration: 0.35 }}
                  className="flex"
                >
                  <ProhibitIcon weight={dropped ? "bold" : "regular"} />
                </motion.span>
              </AnimatePresence>
              {size === "icon" ? null : (
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={dropped ? "on" : "off"}
                    initial={{ opacity: 0, filter: "blur(2px)", y: 3 }}
                    animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                    exit={{ opacity: 0, filter: "blur(2px)", y: -3 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className={cn("flex items-center gap-1", size === "responsive" && "hidden sm:flex")}
                  >
                    {dropped ? "Dropped" : "Drop"}
                    {global ? <span className="opacity-70">· all</span> : null}
                    {dropped ? (
                      <ArrowCounterClockwiseIcon
                        aria-hidden
                        className="opacity-50 transition-opacity group-hover/drop:opacity-100"
                      />
                    ) : null}
                  </motion.span>
                </AnimatePresence>
              )}
            </button>
          </PopoverAnchor>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="w-[min(20rem,calc(100vw-2rem))]"
        onClick={(event) => event.stopPropagation()}
        aria-label={`Confirm dropping ${name}`}
      >
        {gateOpen ? (
          <DropGate
            metric={metric}
            label={label}
            targetJob={newJob}
            onConfirm={confirm}
            onDropFamily={label === undefined ? dropFamily : undefined}
            onCancel={() => setGateOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
