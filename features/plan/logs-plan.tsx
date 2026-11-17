import * as React from "react"
import { ArrowRightIcon, CheckIcon, DatabaseIcon, PercentIcon, PlusIcon, ScissorsIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { logGroupPath, logLabelPath, paths, rulesPath } from "@/app/paths"
import { useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Reveal, Stagger } from "@/components/motion"
import { RiskBadge } from "@/components/risk-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useAutopilot } from "@/features/inbox/autopilot"
import { addLogCut } from "@/features/logs/add-log-cut"
import { PatternText } from "@/features/logs/pattern-table"
import { useLogOpportunities } from "@/features/logs/top-savings"
import { useProposeLogRule } from "@/features/logs/volume-propose"
import { formatBytes } from "@/lib/core/bytes"
import { buildLogsPlan, opportunityService, type LogPlanCut, type LogServicePlan } from "@/lib/core/logs/cut-plan"
import { groupNoun } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { cn } from "@/lib/utils"

// The logs half of the Plan, like the metrics one: what to cut, service by
// service. Add puts a cut straight into the plan; each service links to its
// page to go through its patterns by hand.

export function LogsPlan({ snapshot }: { snapshot: LogsSnapshot }) {
  const { items, planned, loading } = useLogOpportunities(snapshot)
  const propose = useProposeLogRule()
  const services = React.useMemo(() => buildLogsPlan(snapshot, planned), [snapshot, planned])
  const open = services.reduce((sum, service) => sum + service.openSavings, 0)
  useAutopilot(items, loading, (item) => propose(item.rule, { quiet: true }))
  const noun = groupNoun(snapshot.groupLabel)
  const one = groupNoun(snapshot.groupLabel, false)

  return (
    <section className="flex flex-col gap-4" aria-label="Logs">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 pt-2">
        <h2 className="text-lg font-medium tracking-tight">Logs</h2>
        {open > 0 ? <span className="text-sm text-brand-ink tabular-nums">up to −{formatBytes(open)}/day</span> : null}
      </div>
      {loading && services.length === 0 ? (
        <Frame>
          <div className="px-3.5 py-3">
            <Skeleton className="h-4 w-40" />
          </div>
          <FrameWell className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </FrameWell>
        </Frame>
      ) : services.length === 0 ? (
        <Frame>
          <FrameWell>
            <EmptyState
              compact
              title="Nothing obvious to cut in logs"
              description={
                snapshot.imported
                  ? "Logs cuts come from repeated lines and labels, which need a live connection. You can still drop or sample a service from Streams."
                  : `No noisy patterns, debug lines or runaway labels in the top ${noun}.`
              }
            >
              <Button asChild variant="outline" size="sm">
                <Link to={paths.logStreams}>Go through {noun} yourself</Link>
              </Button>
            </EmptyState>
          </FrameWell>
        </Frame>
      ) : (
        <Stagger className="flex flex-col gap-4">
          {services.map((service) => (
            <Reveal key={service.service ?? "\u0000every"}>
              <ServiceCard plan={service} one={one} />
            </Reveal>
          ))}
          {loading ? (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Still reading patterns…
            </p>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              Patterns are read for the top 5 {noun}.{" "}
              <Link to={paths.logStreams} className="text-brand-ink hover:underline">
                Go through any of them yourself
              </Link>
            </p>
          )}
        </Stagger>
      )}
    </section>
  )
}

function ServiceCard({ plan, one }: { plan: LogServicePlan; one: string }) {
  const done = plan.openSavings === 0 && plan.cuts.every((cut) => cut.state === "active")
  return (
    <Frame>
      <FrameHeader
        title={
          plan.service === null ? (
            `Every ${one}`
          ) : (
            <Link
              to={logGroupPath(plan.service)}
              className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {plan.service || "(none)"}
            </Link>
          )
        }
        meta={
          plan.service === null
            ? "labels on every stream"
            : `${formatBytes(plan.bytesPerDay)}/day · ${plan.share < 1 ? plan.share.toFixed(1) : Math.round(plan.share)}% of all`
        }
        action={
          done ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5" aria-hidden />
              In your plan
            </span>
          ) : plan.openSavings > 0 ? (
            <span className="shrink-0 text-sm font-medium text-brand-ink tabular-nums">−{formatBytes(plan.openSavings)}/day</span>
          ) : null
        }
      />
      <FrameWell className="px-2 py-1">
        <ul className="flex flex-col divide-y divide-well-border">
          {plan.cuts.map((cut) => (
            <LogCutRow key={cut.id} cut={cut} />
          ))}
        </ul>
        {plan.service !== null ? (
          <Link
            to={logGroupPath(plan.service)}
            className="group/link mx-2 mt-0.5 mb-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Go through {plan.service || "it"} yourself
            <ArrowRightIcon className="size-3 transition-transform group-hover/link:translate-x-0.5" />
          </Link>
        ) : null}
      </FrameWell>
    </Frame>
  )
}

/** What a cut does, in plain words. */
export function logCutTitle(cut: Pick<LogPlanCut, "reason" | "title">) {
  if (cut.reason === "debug") return "Drop debug and trace lines"
  if (cut.reason === "noisy") return "Keep 10% of a line it repeats"
  return `Move ${cut.title} to structured metadata`
}

function CutIcon({ cut }: { cut: LogPlanCut }) {
  const className = "mt-0.5 size-4 shrink-0 text-muted-foreground"
  if (cut.reason === "debug") return <ScissorsIcon className={className} aria-hidden />
  if (cut.reason === "noisy") return <PercentIcon className={className} aria-hidden />
  return <DatabaseIcon className={className} aria-hidden />
}

function LogCutRow({ cut }: { cut: LogPlanCut }) {
  const { format } = useBytesCost()
  const active = cut.state === "active"
  const saving = cut.savedBytesPerDay
  const cost = saving ? format(saving, "day") : null

  return (
    <li className={cn("flex items-start gap-3 px-2 py-3", active && "opacity-70")}>
      <CutIcon cut={cut} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-sm font-medium break-words">
              {cut.reason === "labels" ? (
                <>
                  Move{" "}
                  <Link to={logLabelPath(cut.title)} className="font-mono hover:underline">
                    {cut.title}
                  </Link>{" "}
                  to structured metadata
                </>
              ) : (
                logCutTitle(cut)
              )}
            </span>
            {active ? null : <RiskBadge risk={cut.risk} />}
          </div>
          {cut.reason === "noisy" ? (
            <div className="line-clamp-2 rounded-lg bg-background/60 px-2 py-1">
              <PatternText pattern={cut.title} className="text-[11.5px]" />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{cut.rule.rationale}</p>
        </div>
        <div className="flex items-center justify-between gap-3 sm:contents">
          <div className="flex shrink-0 flex-col sm:items-end sm:pt-0.5">
            <span className="text-sm font-medium tabular-nums">
              {saving !== null ? `−${formatBytes(saving)}/day` : cut.savedStreams ? `−${cut.savedStreams} streams` : "fewer streams"}
            </span>
            {cost ? <span className="text-[11px] text-muted-foreground tabular-nums">{cost}</span> : null}
          </div>
          {active ? (
            <Button asChild size="xs" variant="ghost" className="w-24 shrink-0 text-muted-foreground">
              <Link to={rulesPath("active")}>
                <CheckIcon data-icon="inline-start" />
                In plan
              </Link>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="w-24 shrink-0"
              onClick={() => addLogCut(cut.rule, { title: cut.reason === "labels" ? logCutTitle(cut) : `${logCutTitle(cut)} (${opportunityService(cut)})` })}
              aria-label={`Add: ${logCutTitle(cut)}`}
            >
              <PlusIcon data-icon="inline-start" />
              Add
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
