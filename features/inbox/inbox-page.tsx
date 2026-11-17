import * as React from "react"
import { PlugsConnectedIcon } from "@phosphor-icons/react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { paths } from "@/app/paths"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { ConnectChooser } from "@/features/settings/connect-chooser"
import { useAppStore } from "@/lib/store/app-store"

// Pieces of the Plan page: the connect card and the note on what the ratings
// learn from.

export function Connect() {
  const navigate = useNavigate()
  return (
    <Frame>
      <FrameHeader icon={PlugsConnectedIcon} title="Connect your data" meta="Queries run from this tab; nothing is stored" />
      <FrameWell>
        <ConnectChooser signal="metrics" onUrl={() => navigate(paths.overview, { state: { connect: "url" } })} />
      </FrameWell>
    </Frame>
  )
}

/** How many decisions the ratings learn from, and a way to forget them. */
export function Learning() {
  const decisions = useAppStore((state) => state.decisions)
  const forget = useAppStore((state) => state.forgetDecisions)
  const count = decisions.filter((decision) => decision.reason !== "later").length
  if (!count) {
    return (
      <p className="px-1 text-xs text-muted-foreground">Ratings adapt as you add cuts and reject proposals. Nothing leaves this browser.</p>
    )
  }
  return (
    <p className="px-1 text-xs text-muted-foreground">
      Ratings also learn from your last {count} {count === 1 ? "decision" : "decisions"}, kept in this browser.{" "}
      <button
        type="button"
        onClick={() => {
          forget()
          toast.success("Forgot your decisions", { description: "Ratings are back to the built-in checks." })
        }}
        className="rounded-sm text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Forget them
      </button>
    </p>
  )
}
