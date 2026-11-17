import { toast } from "sonner"

import { createLogRule, describeLogRule, logRuleKey, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LogRule } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// Adding a log cut the user picked: it goes straight into the plan (active),
// with Undo. It passes through "proposed" first so accepting it is recorded
// like any accepted proposal, which is what ratings learn from. Agent and
// autopilot suggestions still wait in Rules as proposals.

/** Adds the cut as an active rule; returns false when the plan already covers it or it is invalid. */
export function addLogCut(input: LogRuleInput, options: { title?: string; quiet?: boolean } = {}) {
  let rule: LogRule
  try {
    rule = createLogRule({ ...input, origin: input.origin ?? "user", status: "proposed" })
  } catch (error) {
    toast.error("Couldn't add the rule", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
  const before = useAppStore.getState().logRules
  const key = logRuleKey(rule)
  if (before.some((item) => item.status === "active" && logRuleKey(item) === key)) {
    if (!options.quiet) toast.info("Your plan already covers this", { description: describeLogRule(rule) })
    return false
  }
  const { addLogRules, setLogRuleStatus } = useAppStore.getState()
  addLogRules([rule])
  const ids = useAppStore
    .getState()
    .logRules.filter((item) => item.status === "proposed" && logRuleKey(item) === key)
    .map((item) => item.id)
  if (ids.length) setLogRuleStatus(ids, "active")
  if (!options.quiet) {
    toast.success("Added", {
      description: options.title ?? describeLogRule(rule),
      action: { label: "Undo", onClick: () => useAppStore.setState({ logRules: before }) },
    })
  }
  return true
}
