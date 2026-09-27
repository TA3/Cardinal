import { SquaresFourIcon } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLabelDashboardUsage } from "@/features/usage/use-dashboard-usage"
import { describeUsageCounts } from "@/lib/core/grafana-usage"

/**
 * Whether Grafana dashboards and alerts use a label, for the labels table: a
 * count when queries filter, group or display by it, "shown" when panels only
 * plot it unaggregated, "unused" when none does. Nothing without a scan, or
 * when no dashboard reads the metric (the Used by card says so).
 */
export function DashboardLabelBadge({ metric, label }: { metric: string; label: string }) {
  const { evidence, labelUsage } = useLabelDashboardUsage(metric)
  const usage = labelUsage(label)
  if (!evidence || !usage) return null

  if (usage.used.length) {
    const names = Array.from(new Set(usage.used.map((item) => (item.dashboard ? `${item.dashboard.title} › ${item.title}` : item.title))))
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="shrink-0 border-brand/40 font-sans text-brand-ink tabular-nums"
            tabIndex={0}
            aria-label={`${label} is used in ${describeUsageCounts(usage.used)}`}
          >
            <SquaresFourIcon data-icon="inline-start" />
            {usage.used.length}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          Used in {describeUsageCounts(usage.used)}: {usage.uses.slice(0, 3).join(", ")}. {names.slice(0, 3).join("; ")}
          {names.length > 3 ? "; …" : ""}
        </TooltipContent>
      </Tooltip>
    )
  }

  const text = usage.shown.length
    ? `No query filters or groups by ${label}, but ${describeUsageCounts(usage.shown)} ${usage.shown.length === 1 ? "plots" : "plot"} this metric without aggregating it away; dropping it merges their lines.`
    : usage.harmless.length
      ? `Only aggregated away (${usage.harmlessUses[0]}); dropping it changes no panel.`
      : `No dashboard or Grafana alert on ${evidence.host} filters, groups or displays by ${label}.`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="ghost" className="shrink-0 px-1 font-sans text-muted-foreground" tabIndex={0}>
          {usage.shown.length ? "shown" : "unused"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{text}</TooltipContent>
    </Tooltip>
  )
}
