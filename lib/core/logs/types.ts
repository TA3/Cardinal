// Shared shapes for the logs (Loki) side. Metrics keep their own types in
// lib/core/rules.ts and lib/core/snapshot.ts; nothing here is shared with them.

export type MatchOp = "=" | "!=" | "=~" | "!~"

export interface LabelMatcher {
  label: string
  op: MatchOp
  value: string
}

/** A LogQL stream selector, e.g. {service_name="api", level=~"debug|trace"}. */
export interface StreamSelector {
  matchers: LabelMatcher[]
}

export interface LineFilter {
  /** RE2 regex matched against the log line. */
  regex?: string
  /** Match on a detected or labelled log level instead of the line text. */
  levels?: string[]
}

export type LogRuleStatus = "active" | "proposed" | "rejected"
export type LogRuleOrigin = "user" | "import" | "agent"

export interface LogRuleImpact {
  bytesBefore: number
  bytesAfter: number
  streamsBefore?: number
  streamsAfter?: number
  /** False when the numbers are an estimate (label drops, samples, patterns). */
  exact: boolean
  measuredAt: string
  /** Retention rules: days of storage cut per stream (current retention minus the rule's days). */
  retentionSavedDays?: number
  /** Caveat for the UI, e.g. "the index shrinks, not the bytes". */
  note?: string
}

interface LogRuleBase {
  id: string
  selector: StreamSelector
  origin: LogRuleOrigin
  status: LogRuleStatus
  rationale?: string
  impact?: LogRuleImpact
  createdAt: string
}

export interface DropStreamsRule extends LogRuleBase {
  kind: "drop_streams"
}

export interface DropLinesRule extends LogRuleBase {
  kind: "drop_lines"
  line: LineFilter
}

export interface SampleRule extends LogRuleBase {
  kind: "sample"
  line?: LineFilter
  /** Share of matching lines to keep, 0–1. */
  keep: number
}

export interface DropLabelRule extends LogRuleBase {
  kind: "drop_label"
  label: string
}

export interface LabelToMetadataRule extends LogRuleBase {
  kind: "label_to_metadata"
  label: string
}

export interface RetentionRule extends LogRuleBase {
  kind: "retention"
  days: number
}

/**
 * Keeps matching lines on purpose: other log rules (drops, sampling) leave them
 * alone, and Adaptive Logs gets an exemption for the streams. The rationale is
 * required, since a keep is a decision someone has to be able to explain.
 */
export interface KeepRule extends LogRuleBase {
  kind: "keep"
  /** Only these lines; without it, every line of the selected streams. */
  line?: LineFilter
}

export type LogRule = DropStreamsRule | DropLinesRule | SampleRule | DropLabelRule | LabelToMetadataRule | RetentionRule | KeepRule
export type LogRuleKind = LogRule["kind"]

export type LogsRange = "1h" | "24h" | "7d"

export interface LogGroup {
  value: string
  streams: number
  bytes: number
  /** Share of all bytes in the snapshot, 0–100. */
  share: number
}

export interface LogLabelStat {
  label: string
  distinctValues: number
  streams?: number
  bytes?: number
  idLike?: boolean
}

export interface LogsSnapshot {
  capturedAt: string
  host: string
  range: LogsRange
  totals: { streams: number; bytes: number; lines?: number; labelCount: number }
  /** The label rows are grouped by (service_name, job or app). */
  groupLabel: string
  groups: LogGroup[]
  labels: LogLabelStat[]
  /** The "everything" selector the totals were measured with, e.g. {service_name=~".+"}. */
  selector?: string
  /** Groups (by bytes) beyond the top ones got no stream count; `groups` holds only the top ones. */
  groupsTruncated?: boolean
  /** How many group values had volume in the range, including those past the top ones. */
  groupCount?: number
  /** Some labels' value lists hit the cap, so their `distinctValues` is a lower bound. */
  labelsTruncated?: boolean
}

/** A running logs snapshot's progress; `total` is 0 while unknown. */
export interface LogsSnapshotProgress {
  done: number
  total: number
  phase: string
}

/** Per-group bytes and streams of a replaced logs snapshot, for "since last snapshot". */
export interface LogsSnapshotSummary {
  capturedAt: string
  range: LogsRange
  groupLabel: string
  totals: { streams: number; bytes: number }
  /** Top groups only: value → [bytes, streams]. */
  groups: Record<string, [number, number]>
  truncated: boolean
}
