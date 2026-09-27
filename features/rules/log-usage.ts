import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { logqlScanEvidence, useLogqlUsage } from "@/features/usage/logql-scan"
import { connectionKey, LOGS_META, useLogsConnection } from "@/hooks/use-cardinality"
import {
  parseLokiRulesJson,
  parseLokiRulesYaml,
  summarizeLogRule,
  summarizeLogUsage,
  type LogQueryRef,
  type LogRuleTarget,
  type LogUsageEvidence,
} from "@/lib/core/logs/logql-usage"
import type { LogRule } from "@/lib/core/logs/types"
import type { EvidenceSummary } from "@/lib/core/usage-gate"
import { withLokiLimit } from "@/lib/sources/loki"
import { HttpError, send, sendJson, type Connection } from "@/lib/sources/transport"

// Where logs are read, the logs twin of features/rules/usage.ts: Loki's own
// alerting and recording rules (the ruler API on the logs connection) and the
// LogQL scan of Grafana dashboards. One set of hooks for LogRuleToggle's gate,
// the Rules page's Used column, Accept all and the export's PR description.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Loki alerting and recording rules. `/prometheus/api/v1/rules` answers JSON;
 * older rulers only have the YAML `/loki/api/v1/rules`. A ruler without rule
 * groups answers 404 "no rule groups found", which is an empty list.
 */
export async function fetchLokiRuleQueries(connection: Connection, signal?: AbortSignal): Promise<LogQueryRef[]> {
  try {
    return parseLokiRulesJson(await withLokiLimit(connection, () => sendJson<unknown>(connection, { path: "/prometheus/api/v1/rules", signal }), signal))
  } catch (error) {
    if (!(error instanceof HttpError) || error.proxyFailure || ![400, 404, 405, 501].includes(error.status)) throw error
  }
  try {
    const response = await withLokiLimit(connection, () => send(connection, { path: "/loki/api/v1/rules", signal }), signal)
    return parseLokiRulesYaml(await response.text())
  } catch (error) {
    if (error instanceof HttpError && error.status === 404 && /no rule groups/i.test(error.detail)) return []
    throw error
  }
}

export function lokiRulesErrorText(error: unknown) {
  if (error instanceof HttpError && error.status === 403 && /not allowed through the proxy/i.test(error.detail)) {
    return "the Cardinal proxy doesn't allow the rules API path"
  }
  if (error instanceof HttpError && (error.status === 404 || error.status === 501)) return "this Loki has no ruler API"
  return message(error)
}

/** Loki rules on the logs connection; `error` explains why they couldn't be read. */
export function useLokiRules(enabled = true) {
  const connection = useLogsConnection()
  const query = useQuery({
    queryKey: ["loki-rules", connectionKey(connection)],
    enabled: Boolean(connection) && enabled,
    meta: LOGS_META,
    retry: false,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: ({ signal }) => fetchLokiRuleQueries(connection!, signal),
  })
  return { rules: query.data ?? null, error: query.error ? lokiRulesErrorText(query.error) : undefined, isPending: enabled && Boolean(connection) && query.isPending }
}

/** Loki rules plus the LogQL scan, as one evidence object (null while the rules load). */
export function useLogUsageEvidence(enabled = true) {
  const rules = useLokiRules(enabled)
  const usage = useLogqlUsage()
  const evidence = React.useMemo<LogUsageEvidence | null>(
    () => (rules.isPending ? null : { rules: rules.rules, rulesError: rules.error, dashboards: logqlScanEvidence(usage.index) }),
    [rules.isPending, rules.rules, rules.error, usage.index]
  )
  return { evidence, rules, usage, isPending: rules.isPending || usage.loading }
}

/** The gate's summary for one target (a candidate rule), null while loading or without a target. */
export function useLogUsageSummary(target: LogRuleTarget | null, enabled = true) {
  const { evidence, rules, usage, isPending } = useLogUsageEvidence(enabled && target !== null)
  const summary = React.useMemo(() => (target && evidence ? summarizeLogUsage({ ...evidence, target }) : null), [target, evidence])
  return { summary, evidence, rules, usage, isPending }
}

/** Summaries per rule id (keep rules have none), for tables, Accept all and the PR description. */
export function useLogUsageSummaries(rules: LogRule[], enabled = true) {
  const { evidence, isPending } = useLogUsageEvidence(enabled && rules.length > 0)
  const summaries = React.useMemo(() => {
    const result: Record<string, EvidenceSummary> = {}
    if (!evidence) return result
    for (const rule of rules) {
      const summary = summarizeLogRule(rule as LogRule & { label?: string }, evidence)
      if (summary) result[rule.id] = summary
    }
    return result
  }, [rules, evidence])
  return { summaries, isPending: enabled && rules.length > 0 && isPending }
}
