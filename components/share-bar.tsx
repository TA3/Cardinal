import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

/** A value's share of a total: percentage text with a thin bar. */
export function ShareBar({ percent, showValue = true, className }: { percent: number; showValue?: boolean; className?: string }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className={cn("flex min-w-28 items-center gap-2", className)}>
      <Progress value={clamped} className="h-1.5 flex-1" />
      {showValue ? (
        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{clamped.toFixed(clamped < 10 ? 1 : 0)}%</span>
      ) : null}
    </div>
  )
}
