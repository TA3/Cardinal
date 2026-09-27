import * as React from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { rulesPath } from "@/app/paths"
import { createLogRule, describeLogRule, type LogRuleInput } from "@/lib/core/logs/rules"
import type { LogRule } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// Proposals from the Volume page (like the metrics Churn page's): always
// "proposed", never active, so they wait in Rules for review.

export function useProposeLogRule() {
  const addLogRules = useAppStore((state) => state.addLogRules)
  const navigate = useNavigate()
  return React.useCallback(
    (input: LogRuleInput, options: { success?: string } = {}) => {
      let rule: LogRule
      try {
        rule = createLogRule({ ...input, origin: "user", status: "proposed" })
      } catch (error) {
        toast.error("Couldn't create the rule", { description: error instanceof Error ? error.message : String(error) })
        return false
      }
      const { added } = addLogRules([rule])
      if (!added) {
        toast.info("A rule already covers this", { description: describeLogRule(rule) })
        return false
      }
      toast.success(options.success ?? "Proposed a log rule", {
        description: `${describeLogRule(rule)}. It waits in Rules for review.`,
        action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) },
      })
      return true
    },
    [addLogRules, navigate]
  )
}
