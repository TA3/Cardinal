import type { MergeChoice } from "@/lib/core/rules"

// The default for a label drop that merges series, so a plan doesn't stall
// on a question with an obvious answer. Nothing uses the label: drop it
// anyway. Something may use it and the destination can aggregate: keep the
// totals. Otherwise it stays the user's call (keeping one value needs a value
// picked, which only a person can do).

export function suggestMergeChoice({ used, choices }: { used: boolean | undefined; choices: MergeChoice[] }): MergeChoice | null {
  if (used === false) return "drop"
  if (used === true && choices.includes("aggregate")) return "aggregate"
  return null
}

/** Why the suggested choice was picked, for the hint under the control. */
export const MERGE_DEFAULT_REASON: Record<MergeChoice, string> = {
  drop: "Default: nothing uses it.",
  aggregate: "Default: something may use it, so totals are kept.",
  keep_value: "",
}
