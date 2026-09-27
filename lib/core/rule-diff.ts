import { ruleKey, type Rule } from "@/lib/core/rules"

// What an export changes compared with the rules the user imported (i.e. what
// already runs): new rules, rules that gained labels, rules already in place,
// and imported rules no longer in the set.

/** The part of a rule that matters for "is it already deployed". */
export interface RuleFingerprint {
  key: string
  /** Labels (drop_labels) or kept buckets (keep_buckets); empty otherwise. */
  items: string[]
}

export function fingerprint(rule: Rule): RuleFingerprint {
  const items = rule.kind === "drop_labels" ? rule.labels : rule.kind === "keep_buckets" ? rule.buckets : []
  return { key: ruleKey(rule), items: [...items] }
}

export interface RuleSetDiff {
  /** Not in the imported set at all. */
  added: Rule[]
  /** Same target as an imported rule but with different labels or buckets. */
  changed: Array<{ rule: Rule; before: string[] }>
  /** Exactly as imported. */
  unchanged: Rule[]
  /** Imported rules that are no longer active. */
  removed: RuleFingerprint[]
}

/** Compares active rules with the imported baseline. */
export function diffAgainstBaseline(baseline: RuleFingerprint[], rules: Rule[]): RuleSetDiff {
  const byKey = new Map(baseline.map((item) => [item.key, item]))
  const seen = new Set<string>()
  const diff: RuleSetDiff = { added: [], changed: [], unchanged: [], removed: [] }
  for (const rule of rules) {
    if (rule.status !== "active") continue
    const current = fingerprint(rule)
    seen.add(current.key)
    const before = byKey.get(current.key)
    if (!before) diff.added.push(rule)
    else if (before.items.join("\u0000") === current.items.join("\u0000")) diff.unchanged.push(rule)
    else diff.changed.push({ rule, before: before.items })
  }
  diff.removed = baseline.filter((item) => !seen.has(item.key))
  return diff
}

/** Adds imported rules to a baseline (merge import) or replaces it (replace import). */
export function updateBaseline(baseline: RuleFingerprint[], imported: Rule[], mode: "merge" | "replace") {
  const next = new Map(mode === "replace" ? [] : baseline.map((item) => [item.key, item]))
  for (const rule of imported) {
    const print = fingerprint(rule)
    const existing = next.get(print.key)
    // Label drops add up; a bucket keep replaces the one before.
    const union = existing && rule.kind === "drop_labels"
    next.set(print.key, union ? { key: print.key, items: Array.from(new Set([...existing.items, ...print.items])).sort() } : print)
  }
  return Array.from(next.values())
}

/** A human description of a fingerprint key, e.g. `drop_labels http_requests_total (job api)`. */
export function describeKey(key: string) {
  try {
    const [kind, job, metric, label, regex] = JSON.parse(key) as [string, string | null, string, string?, string?]
    const scope = job === null ? "" : ` (job ${job === "" ? "(no job)" : job})`
    const match = label !== undefined ? ` where ${label}=~"${regex}"` : ""
    return `${kind} ${metric}${match}${scope}`
  } catch {
    return key
  }
}
