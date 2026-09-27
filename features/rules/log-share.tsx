import * as React from "react"
import { DownloadSimpleIcon, LinkIcon, ShareNetworkIcon, TrayArrowDownIcon, XIcon } from "@phosphor-icons/react"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { Tip } from "@/components/tip"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { downloadFile } from "@/features/rules/share"
import { copyText } from "@/lib/clipboard"
import { LOG_SHARE_HASH_KEY, logRuleSetJson, logShareHash, readLogShareHash, type ParsedLogRuleSet } from "@/lib/core/logs/share"
import type { LogRule } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

const LONG_LINK = 8000

/** True when the location hash carries a log rule set (`#logrules=`), so the Rules page shows logs. */
export function hasLogShareHash(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, "")).has(LOG_SHARE_HASH_KEY)
}

/** Share the log rule set: a JSON download, or a `#logrules=` link. */
export function LogShareMenu({ rules }: { rules: LogRule[] }) {
  const shareable = rules.filter((rule) => rule.status !== "rejected")
  const copyLink = async () => {
    const url = `${window.location.origin}${paths.rules}${logShareHash(shareable)}`
    try {
      await copyText(url)
      toast.success("Share link copied", {
        description:
          url.length > LONG_LINK
            ? `The link is ${Math.round(url.length / 1000)} kB long and may get cut; download the JSON instead.`
            : `${shareable.length} log rules. Whoever opens it gets them as proposals to review.`,
      })
    } catch {
      toast.error("Could not copy the link")
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={shareable.length === 0}>
          <ShareNetworkIcon data-icon="inline-start" />
          Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setTimeout(() => void copyLink(), 0)}>
          <LinkIcon />
          Copy share link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => downloadFile("cardinal-log-rules.json", logRuleSetJson(shareable), "application/json")}>
          <DownloadSimpleIcon />
          Download JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Offers the log rules in a `#logrules=` link as proposals; nothing is added until the user says so. */
export function SharedLogRulesBanner() {
  const location = useLocation()
  const navigate = useNavigate()
  const addLogRules = useAppStore((state) => state.addLogRules)
  const shared = React.useMemo((): ParsedLogRuleSet | string | null => {
    try {
      return readLogShareHash(location.hash)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [location.hash])

  if (!shared) return null
  const dismiss = () => navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true })

  if (typeof shared === "string") {
    return (
      <Alert variant="destructive">
        <TrayArrowDownIcon />
        <AlertTitle>This share link can't be read</AlertTitle>
        <AlertDescription>{shared}</AlertDescription>
        <AlertAction>
          <Tip label="Dismiss">
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={dismiss}>
              <XIcon />
            </Button>
          </Tip>
        </AlertAction>
      </Alert>
    )
  }

  const add = () => {
    const { added, skipped } = addLogRules(shared.rules)
    // The Rules page follows the signal once the hash is gone: stay on logs.
    useAppStore.setState({ signal: "logs" })
    toast.success(`Added ${added} log proposal${added === 1 ? "" : "s"}`, {
      description: skipped ? `${skipped} already covered by your rules.` : "Review them before accepting.",
    })
    navigate({ pathname: location.pathname, search: "?tab=proposed", hash: "" }, { replace: true })
  }

  return (
    <Alert>
      <TrayArrowDownIcon />
      <AlertTitle>
        A shared log rule set with {shared.rules.length} rule{shared.rules.length === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        They come in as proposals for you to review; nothing becomes active on its own.
        {shared.warnings.length ? ` ${shared.warnings.length} invalid rule${shared.warnings.length === 1 ? " was" : "s were"} left out.` : ""}
        <span className="mt-2 flex gap-2">
          <Button size="sm" disabled={!shared.rules.length} onClick={add}>
            Add as proposals
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}
