import { ArrowRightIcon, LightningIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths, rulesPath } from "@/app/paths"
import { Frame } from "@/components/frame"
import { Spinner } from "@/components/ui/spinner"

// One line on a signal's overview pointing at Savings and Rules, instead of
// repeating their lists here: Overview stays about the data.

export function SavingsLine({
  loading,
  open,
  safe,
  total,
  unchecked,
  activeRules,
}: {
  loading: boolean
  /** Open cuts, and how many of them are rated safe. */
  open: number
  safe: number
  /** What the open cuts save, e.g. "−120,000 series". */
  total: string | null
  /** Nothing about usage was checked, so cuts can't be found yet. */
  unchecked?: boolean
  activeRules: number
}) {
  const message = loading
    ? "Looking for cuts…"
    : open
      ? `${open} ${open === 1 ? "cut" : "cuts"}${total ? `, up to ${total}` : ""}${safe ? ` · ${safe} safe` : ""}`
      : unchecked
        ? "Check usage to find cuts"
        : "Nothing obvious to cut"
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {loading ? <Spinner className="size-4 text-muted-foreground" /> : <LightningIcon className="size-4 shrink-0 text-brand" />}
          <span className="font-medium">{message}</span>
        </span>
        {activeRules ? (
          <Link to={rulesPath("active")} className="text-muted-foreground hover:text-foreground hover:underline">
            {activeRules} {activeRules === 1 ? "rule" : "rules"} active
          </Link>
        ) : null}
        <Link
          to={unchecked && !open ? `${paths.settings}#grafana` : paths.savings}
          className="ml-auto inline-flex items-center gap-1 rounded-sm font-medium text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {unchecked && !open ? "Add usage" : "Open Savings"}
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
    </Frame>
  )
}
