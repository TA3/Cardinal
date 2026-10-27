import { CheckCircleIcon, CircleIcon, ListChecksIcon, XIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths, rulesPath } from "@/app/paths"
import { readPricePer1k, readPricePerGB } from "@/components/cost-text"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Reveal } from "@/components/motion"
import { Button } from "@/components/ui/button"
import { useGrafanaIndex } from "@/features/usage/use-dashboard-usage"
import { useIsGrafanaCloud } from "@/hooks/use-cardinality"
import { cn } from "@/lib/utils"
import { selectHasLogs, useAppStore } from "@/lib/store/app-store"

// Onboarding on the Savings page, once a data source is connected: the few
// steps that make the ratings and numbers trustworthy, each one click away.
// It goes once every step is done, or when dismissed.

interface Step {
  id: string
  title: string
  why: string
  done: boolean
  to: string
  action: string
}

function useSetupSteps(): Step[] {
  const connected = useAppStore((state) => Boolean(state.snapshot || (state.logsSnapshot && selectHasLogs(state))))
  const priced = useAppStore((state) => readPricePer1k(state.settings) !== undefined || readPricePerGB(state.settings) !== undefined)
  const reviewed = useAppStore(
    (state) =>
      state.decisions.length > 0 || state.rules.some((rule) => rule.status === "active") || state.logRules.some((rule) => rule.status === "active")
  )
  const cloud = useIsGrafanaCloud()
  const { index } = useGrafanaIndex()
  return [
    {
      id: "connect",
      title: "Connect metrics or logs",
      why: "Cardinal reads series and streams from this tab.",
      done: connected,
      to: paths.settings,
      action: "Connect",
    },
    {
      id: "usage",
      title: "Check dashboard usage",
      why: "Scan Grafana or upload dashboard exports so cuts nothing uses can be rated safe.",
      done: cloud || Boolean(index),
      to: `${paths.settings}#grafana`,
      action: "Add usage",
    },
    {
      id: "price",
      title: "Set your prices",
      why: "Shows what each cut is worth per month.",
      done: priced,
      to: `${paths.settings}#pricing`,
      action: "Set prices",
    },
    {
      id: "review",
      title: "Review a proposal",
      why: "Accept or reject one in Rules; ratings learn from what you decide.",
      done: reviewed,
      to: rulesPath("proposed"),
      action: "Open Rules",
    },
  ]
}

export function SetupChecklist() {
  const dismissed = useAppStore((state) => state.setupDismissed)
  const dismiss = useAppStore((state) => state.setSetupDismissed)
  const steps = useSetupSteps()
  const done = steps.filter((step) => step.done).length
  if (dismissed || done === steps.length) return null
  const next = steps.find((step) => !step.done)
  return (
    <Reveal>
      <Frame>
        <FrameHeader
          icon={ListChecksIcon}
          title="Get set up"
          meta={`${done} of ${steps.length} done`}
          action={
            <Button size="icon-xs" variant="ghost" aria-label="Dismiss setup" onClick={() => dismiss(true)}>
              <XIcon />
            </Button>
          }
        />
        <FrameWell className="py-2">
          <ol className="flex flex-col">
            {steps.map((step) => (
              <li key={step.id} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-1.5">
                {step.done ? (
                  <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-brand" aria-label="Done" />
                ) : (
                  <CircleIcon className="size-4 shrink-0 text-muted-foreground" aria-label="To do" />
                )}
                <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                  <span className={cn("text-sm", step.done && "text-muted-foreground line-through decoration-muted-foreground/50")}>
                    {step.title}
                  </span>
                  {!step.done ? <span className="truncate text-xs text-muted-foreground">{step.why}</span> : null}
                </div>
                {!step.done ? (
                  <Button asChild size="xs" variant={step === next ? "default" : "outline"} className="shrink-0">
                    <Link to={step.to}>{step.action}</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        </FrameWell>
      </Frame>
    </Reveal>
  )
}
