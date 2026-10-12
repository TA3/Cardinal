import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RISK_LABEL, type Assessment, type RiskLevel } from "@/lib/core/decide/risk"
import { cn } from "@/lib/utils"

const DOT: Record<RiskLevel, string> = {
  safe: "bg-emerald-500",
  review: "bg-amber-500",
  risky: "bg-destructive",
}

/** "Safe" / "Review" / "Risky" with a colored dot; the reasons and confidence in a tooltip. */
export function RiskBadge({ risk, className }: { risk: Assessment; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("h-5 gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground", className)} tabIndex={0}>
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[risk.level])} />
          {RISK_LABEL[risk.level]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col gap-1">
            {risk.why.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="opacity-70">Checked: {Math.round(risk.confidence * 100)}% of the evidence</p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
