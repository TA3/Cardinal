import { ArrowSquareOutIcon, BellIcon, SquaresFourIcon } from "@phosphor-icons/react"

import { groupByDashboard, type DashboardUsage } from "@/lib/core/grafana-usage"
import { cn } from "@/lib/utils"

const external = { target: "_blank", rel: "noreferrer noopener" } as const

function usageTitle(usage: DashboardUsage, label?: string) {
  const uses = label ? (usage.labels[label] ?? []).map((use) => use.text) : []
  return [uses.length ? `${label}: ${uses.join(", ")}` : null, usage.expr].filter(Boolean).join("\n")
}

/**
 * Dashboards, panels, variables and Grafana alerts that read a metric, each
 * linking to Grafana. With `label`, each panel shows how it uses that label.
 */
export function DashboardUsageList({
  usages,
  label,
  maxGroups = 4,
  maxPanels = 6,
  className,
}: {
  usages: DashboardUsage[]
  label?: string
  maxGroups?: number
  maxPanels?: number
  className?: string
}) {
  const groups = groupByDashboard(usages)
  if (!groups.length) return null
  const hidden = groups.length - maxGroups
  return (
    <ul className={cn("flex flex-col gap-2 text-xs", className)}>
      {groups.slice(0, maxGroups).map((group) => {
        const key = group.dashboard?.url ?? "alerts"
        const Icon = group.dashboard ? SquaresFourIcon : BellIcon
        const extra = group.usages.length - maxPanels
        return (
          <li key={key} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {group.dashboard ? (
                <a
                  href={group.dashboard.url}
                  {...external}
                  className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  <span className="truncate">{group.dashboard.title}</span>
                  <ArrowSquareOutIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              ) : (
                <span className="font-medium">Grafana alert rules</span>
              )}
              {group.dashboard?.folder ? <span className="truncate text-muted-foreground">{group.dashboard.folder}</span> : null}
            </div>
            <div className="flex flex-wrap gap-1 pl-5">
              {group.usages.slice(0, maxPanels).map((usage) => {
                const uses = label ? (usage.labels[label] ?? []) : []
                return (
                  <a
                    key={`${usage.kind}:${usage.url}:${usage.title}`}
                    href={usage.url}
                    {...external}
                    title={usageTitle(usage, label)}
                    className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className={cn("truncate", usage.kind === "variable" && "font-mono")}>{usage.title}</span>
                    {uses.length ? <code className="shrink-0 font-mono text-[11px] text-brand-ink">{uses[0].text}</code> : null}
                  </a>
                )
              })}
              {extra > 0 ? <span className="px-1 py-0.5 text-muted-foreground">+{extra} more</span> : null}
            </div>
          </li>
        )
      })}
      {hidden > 0 ? (
        <li className="pl-5 text-muted-foreground">
          and {hidden} more dashboard{hidden === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  )
}
