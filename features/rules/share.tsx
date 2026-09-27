import * as React from "react"
import { DownloadSimpleIcon, LinkIcon, ShareNetworkIcon, TrayArrowDownIcon, XIcon } from "@phosphor-icons/react"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tip } from "@/components/tip"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { copyText } from "@/lib/clipboard"
import { readShareHash, ruleSetJson, shareHash, type ParsedRuleSet } from "@/lib/core/share"
import type { Rule } from "@/lib/core/rules"
import { useAppStore } from "@/lib/store/app-store"

/** Saves text as a file through a temporary link. */
export function downloadFile(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Links longer than this may be cut by chat tools and some browsers.
const LONG_LINK = 8000

/** Share the rule set: a JSON download, or a link with the rules in its hash. */
export function ShareMenu({ rules }: { rules: Rule[] }) {
  const shareable = rules.filter((rule) => rule.status !== "rejected")
  const copyLink = async () => {
    const url = `${window.location.origin}${paths.rules}${shareHash(shareable)}`
    try {
      await copyText(url)
      toast.success("Share link copied", {
        description:
          url.length > LONG_LINK
            ? `The link is ${Math.round(url.length / 1000)} kB long and may get cut; download the JSON instead.`
            : `${shareable.length} rules. Whoever opens it gets them as proposals to review.`,
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
        {/* Copy once the menu has closed: its focus trap would steal focus from the copy fallback on plain http. */}
        <DropdownMenuItem onSelect={() => setTimeout(() => void copyLink(), 0)}>
          <LinkIcon />
          Copy share link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => downloadFile("cardinal-rules.json", ruleSetJson(shareable), "application/json")}>
          <DownloadSimpleIcon />
          Download JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Offers the rules in a `#rules=` link as proposals. Nothing is added until
 * the user says so, and never as active rules.
 */
export function SharedRulesBanner() {
  const location = useLocation()
  const navigate = useNavigate()
  const addRules = useAppStore((state) => state.addRules)
  const shared = React.useMemo((): ParsedRuleSet | string | null => {
    try {
      return readShareHash(location.hash)
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
    const { added, skipped } = addRules(shared.rules)
    toast.success(`Added ${added} proposal${added === 1 ? "" : "s"}`, {
      description: skipped ? `${skipped} already covered by your rules.` : "Review them before accepting.",
    })
    navigate({ pathname: location.pathname, search: "?tab=proposed", hash: "" }, { replace: true })
  }

  return (
    <Alert>
      <TrayArrowDownIcon />
      <AlertTitle>
        A shared rule set with {shared.rules.length} rule{shared.rules.length === 1 ? "" : "s"}
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
