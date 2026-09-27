import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { EvidenceSummary } from "@/lib/core/usage-gate"

/**
 * The Rules tables' Used cell, for metrics and logs alike: "Used · 2 alerts"
 * when something reads what the rule cuts, else "Not found" (something wasn't
 * checked) or "Unused", with the evidence in a tooltip.
 */
export function UsedBadge({ summary, pending, subject }: { summary?: EvidenceSummary | null; pending: boolean; subject: string }) {
  if (!summary) return <span className="text-xs text-muted-foreground">{pending ? "checking…" : "–"}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {summary.used ? (
          <Badge variant="outline" className="max-w-40 border-brand/40 text-brand-ink" tabIndex={0}>
            <span className="truncate">Used{summary.badge ? ` · ${summary.badge}` : ""}</span>
          </Badge>
        ) : (
          <Badge variant="ghost" className="text-muted-foreground" tabIndex={0}>
            {summary.unchecked.length ? "Not found" : "Unused"}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {summary.found.length ? (
          <ul className="flex flex-col gap-1">
            {summary.found.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>Nothing Cardinal checked reads {subject}.</p>
        )}
        {summary.unchecked.map((line) => (
          <p key={line} className="mt-1 opacity-70">
            {line}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
