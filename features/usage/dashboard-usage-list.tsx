import { ArrowSquareOutIcon, BellIcon, SquaresFourIcon } from "@phosphor-icons/react"

import { groupByDashboard, type DashboardUsage } from "@/lib/core/grafana-usage"
import { cn } from "@/lib/utils"

const external = { target: "_blank", rel: "noreferrer noopener" } as const

/** Usages from uploaded files without a Grafana URL, and Prometheus rule files, have nowhere to link to. */
const linkable = (url: string) => /^https?:\/\//.test(url)

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
              {group.dashboard && !linkable(group.dashboard.url) ? (
                <span className="truncate font-medium">{group.dashboard.title}</span>
              ) : group.dashboard ? (
                <a
                  href={group.dashboard.url}
                  {...external}
                  className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  <span className="truncate">{group.dashboard.title}</span>
                  <ArrowSquareOutIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              ) : (
                <span className="font-medium">Alert and recording rules</span>
              )}
              {group.dashboard?.folder ? <span className="truncate text-muted-foreground">{group.dashboard.folder}</span> : null}
            </div>
            <div className="flex flex-wrap gap-1 pl-5">
              {group.usages.slice(0, maxPanels).map((usage) => {
                const uses = label ? (usage.labels[label] ?? []) : []
                const content = (
                  <>
                    <span className={cn("truncate", usage.kind === "variable" && "font-mono")}>{usage.title}</span>
                    {uses.length ? <code className="shrink-0 font-mono text-[11px] text-brand-ink">{uses[0].text}</code> : null}
                  </>
                )
                const chip = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5"
                return linkable(usage.url) ? (
                  <a
                    key={`${usage.kind}:${usage.url}:${usage.title}`}
                    href={usage.url}
                    {...external}
                    title={usageTitle(usage, label)}
                    className={cn(chip, "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none")}
                  >
                    {content}
                  </a>
                ) : (
                  <span key={`${usage.kind}:${usage.url}:${usage.title}`} title={usageTitle(usage, label)} className={chip}>
                    {content}
                  </span>
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
