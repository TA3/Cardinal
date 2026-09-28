import { ArrowSquareOutIcon, CopyIcon, NetworkIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { Link } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { InfoTip } from "@/components/info-tip"
import { Button } from "@/components/ui/button"
import type { ConnectionProblem } from "@/features/settings/connection-check"
import { copyText } from "@/lib/clipboard"
import type { ConnectionSettings } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

export const SELF_HOST_DOCS = "https://github.com/TA3/cardinal#self-host"

/** Relay setup (Settings → Advanced → Relay) and the self-host docs: where to go for a private host. */
export function RelayLinks() {
  return (
    <>
      <Button asChild size="xs" variant="outline">
        <Link to={`${paths.settings}#relay`}>
          <NetworkIcon data-icon="inline-start" />
          Set up a relay
        </Link>
      </Button>
      <Button asChild size="xs" variant="ghost">
        <a href={SELF_HOST_DOCS} target="_blank" rel="noreferrer">
          Self-host
          <ArrowSquareOutIcon data-icon="inline-end" />
        </a>
      </Button>
    </>
  )
}

/** A connection problem as one line: what's wrong, the fix as a button, the explanation behind "Why?". */
export function ProblemLine({
  problem,
  onFix,
  className,
}: {
  problem: Pick<ConnectionProblem, "kind" | "title" | "detail" | "snippet" | "fix" | "help">
  onFix?: (patch: Partial<ConnectionSettings>) => void
  className?: string
}) {
  const soft = problem.kind === "cors" || problem.kind === "private-proxy"
  const copy = async (snippet: string) => {
    try {
      await copyText(snippet)
      toast.success("Copied")
    } catch {
      toast.error("Could not copy")
    }
  }
  return (
    <div
      role="alert"
      data-problem={problem.kind}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border px-3 py-2",
        soft ? "border-brand/30 bg-brand/5" : "border-destructive/30 bg-destructive/5",
        className
      )}
    >
      <p className={cn("flex min-w-0 flex-1 basis-56 items-start gap-1.5 text-sm font-medium", soft ? "text-brand-ink" : "text-destructive")}>
        <WarningCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0">{problem.title}</span>
        {problem.detail ? (
          <InfoTip label="Why?" className="-my-0.5">
            {problem.detail}
          </InfoTip>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {problem.fix && onFix ? (
          <Button type="button" size="xs" variant="outline" onClick={() => onFix(problem.fix!.patch)}>
            {problem.fix.label}
          </Button>
        ) : null}
        {problem.help === "relay" ? <RelayLinks /> : null}
        {problem.snippet ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => void copy(problem.snippet!)} title={problem.snippet}>
            <CopyIcon data-icon="inline-start" />
            {problem.snippet.startsWith("--web.cors") ? "Copy CORS flag" : "Copy command"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
