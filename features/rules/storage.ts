import * as React from "react"

import type { AdaptiveBackup } from "@/lib/core/compile/adaptive-metrics"
import type { LogAdaptiveBackup, PendingExemption } from "@/lib/core/logs/adaptive-apply"
import { updateBaseline, type RuleFingerprint } from "@/lib/core/rule-diff"
import type { Rule } from "@/lib/core/rules"

// Small per-browser records the Rules page keeps next to the store: the rules
// last imported (what already runs, for the export diff), the Adaptive
// Metrics rule set before Cardinal's last apply (for revert), and the Grafana
// stack URL for linking to the Adaptive Metrics UI.

const BASELINE_KEY = "cardinal.import-baseline.v1"
const BACKUP_PREFIX = "cardinal.adaptive-backup.v1:"
const STACK_URL_KEY = "cardinal.grafana-stack-url"
const LOG_BACKUP_PREFIX = "cardinal.adaptive-logs-backup.v1:"
const EXEMPTIONS_PREFIX = "cardinal.adaptive-logs-exemptions.v1:"

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
    window.dispatchEvent(new CustomEvent("cardinal:rules-storage", { detail: key }))
    return true
  } catch {
    return false
  }
}

export function readImportBaseline(): RuleFingerprint[] | null {
  const value = read<RuleFingerprint[]>(BASELINE_KEY)
  return Array.isArray(value) ? value : null
}

export function recordImport(rules: Rule[], mode: "merge" | "replace") {
  write(BASELINE_KEY, updateBaseline(readImportBaseline() ?? [], rules, mode))
}

export function clearImportBaseline() {
  write(BASELINE_KEY, null)
}

/** Backups are keyed by connection so a revert never writes another stack's rules. */
export function readAdaptiveBackup(connKey: string): AdaptiveBackup | null {
  return read<AdaptiveBackup>(BACKUP_PREFIX + connKey)
}

export function storeAdaptiveBackup(connKey: string, backup: AdaptiveBackup | null) {
  return write(BACKUP_PREFIX + connKey, backup)
}

/** The Adaptive Logs drop rules Cardinal changed in its last apply, per logs connection. */
export function readLogAdaptiveBackup(connKey: string): LogAdaptiveBackup | null {
  return read<LogAdaptiveBackup>(LOG_BACKUP_PREFIX + connKey)
}

export function storeLogAdaptiveBackup(connKey: string, backup: LogAdaptiveBackup | null) {
  return write(LOG_BACKUP_PREFIX + connKey, backup)
}

/** Exemptions proposed in Cardinal, created in Grafana Cloud on the next Adaptive Logs apply. */
export function readPendingExemptions(connKey: string): PendingExemption[] {
  const value = read<PendingExemption[]>(EXEMPTIONS_PREFIX + connKey)
  return Array.isArray(value) ? value : []
}

export function storePendingExemptions(connKey: string, exemptions: PendingExemption[]) {
  return write(EXEMPTIONS_PREFIX + connKey, exemptions.length ? exemptions : null)
}

export function readStackUrl() {
  return read<string>(STACK_URL_KEY) ?? ""
}

export function storeStackUrl(url: string) {
  write(STACK_URL_KEY, url || null)
}

/** Bumps whenever this module writes (in this tab) or another tab changes storage; use it to re-read. */
export function useStorageVersion() {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    const bump = () => setVersion((current) => current + 1)
    window.addEventListener("cardinal:rules-storage", bump)
    window.addEventListener("storage", bump)
    return () => {
      window.removeEventListener("cardinal:rules-storage", bump)
      window.removeEventListener("storage", bump)
    }
  }, [])
  return version
}
