import { detectIdLike } from "@/lib/core/id-like"
import { streamsWithoutLabel } from "@/lib/core/logs/impact"
import { isInternalLabel } from "@/lib/core/logs/snapshot"

// What to do about a stream label, in plain words: move it to structured
// metadata, drop it, or keep it. Pure; the labels page and the stream group
// page feed it snapshot numbers or a group's stream listing.

/** Labels that Grafana, Loki and most routing rely on: dropping them needs an explicit override. */
export const GUARDED_LOG_LABELS: Record<string, { title: string; reason: string }> = {
  service_name: {
    title: "service_name identifies the service",
    reason: "Grafana Logs Drilldown, Adaptive Logs and most dashboards find logs by service_name. Without it these streams show up as unknown_service.",
  },
  job: {
    title: "job is how many queries find these logs",
    reason: "Dashboards and alerts often select streams by job, and Loki falls back to it for service_name. Queries selecting by job would stop matching.",
  },
  namespace: {
    title: "namespace scopes Kubernetes logs",
    reason: "Most Kubernetes dashboards, alerts and access policies select logs by namespace. Queries selecting by namespace would stop matching.",
  },
  cluster: {
    title: "cluster tells environments apart",
    reason: "Without cluster, streams from different clusters merge and queries scoped to one cluster stop matching.",
  },
}

export function guardedLogLabel(label: string | undefined) {
  return label === undefined ? undefined : GUARDED_LOG_LABELS[label]
}

export type LabelAdviceKind = "label_to_metadata" | "drop_label" | "watch" | "keep"

export interface LabelAdvice {
  kind: LabelAdviceKind
  /** strong: act on it; suggested: likely worth it; none: nothing to do. */
  strength: "strong" | "suggested" | "none"
  /** A few words for a table cell. */
  title: string
  /** One or two sentences in plain words. */
  reason: string
}

export interface LabelAdviceInput {
  label: string
  distinctValues: number
  idLike?: boolean
  /** Streams carrying the label, when measured. */
  streams?: number
  /** `distinctValues` is a lower bound (the value list was capped). */
  truncated?: boolean
}

/** Distinct values at or above this are high cardinality for a stream label. */
export const HIGH_CARDINALITY = 1000
/** ID-like labels with at least this many values are worth moving already. */
export const ID_LIKE_MIN_VALUES = 50
/** Below this many streams, "one value per stream" is not telling. */
const UNIQUE_MIN_STREAMS = 20

const count = (value: number, truncated?: boolean) => `${value.toLocaleString("en-US")}${truncated ? "+" : ""}`

/**
 * The recommendation for one label:
 * - guarded labels (service_name, job, namespace, cluster): keep;
 * - one value per stream: move to structured metadata (it alone creates the streams);
 * - ID-like with many values, or very high cardinality: move to structured metadata;
 * - a single value: drop (it tells no streams apart);
 * - ID-like but still few values: watch;
 * - otherwise keep.
 */
export function adviseLogLabel(input: LabelAdviceInput): LabelAdvice {
  const { label, distinctValues, idLike, streams, truncated } = input
  const values = count(distinctValues, truncated)
  const guard = guardedLogLabel(label)
  if (guard) {
    return { kind: "keep", strength: "none", title: "Keep", reason: `${guard.title}. ${guard.reason}` }
  }
  if (streams !== undefined && streams >= UNIQUE_MIN_STREAMS && distinctValues >= streams * 0.9) {
    return {
      kind: "label_to_metadata",
      strength: "strong",
      title: "Move to metadata",
      reason: `One value per stream: ${values} values across ${count(streams)} streams, so this label on its own is what creates them. Moved to structured metadata it stays searchable without creating streams.`,
    }
  }
  if (idLike && distinctValues >= ID_LIKE_MIN_VALUES) {
    return {
      kind: "label_to_metadata",
      strength: "strong",
      title: "Move to metadata",
      reason: `High cardinality and ID-like: ${values} values that look like IDs, and each new one starts a new stream. As structured metadata it is still filterable with | ${label}="…", without new streams.`,
    }
  }
  if (distinctValues >= HIGH_CARDINALITY) {
    return {
      kind: "label_to_metadata",
      strength: "suggested",
      title: "Move to metadata",
      reason: `High cardinality: ${values} values multiply streams and chunks. Unless queries select streams by it, structured metadata is cheaper.`,
    }
  }
  if (distinctValues === 1 && !truncated) {
    return {
      kind: "drop_label",
      strength: "suggested",
      title: "Drop",
      reason: "Constant: it has the same value on every stream that carries it, so it tells no streams apart. Dropping it is safe and shrinks the index.",
    }
  }
  if (idLike) {
    return {
      kind: "watch",
      strength: "none",
      title: "Watch",
      reason: `Its values look like IDs but there are only ${values} so far. If they keep growing, move it to structured metadata.`,
    }
  }
  return { kind: "keep", strength: "none", title: "Keep", reason: `Bounded: ${values} values is fine for a stream label.` }
}

export interface GroupLabelStat {
  label: string
  /** Distinct values among the listed streams. */
  distinctValues: number
  /** Listed streams carrying the label. */
  streams: number
  /** Streams left if the label were dropped (distinct label sets without it), among the listed streams. */
  streamsIfDropped: number
  /** Values by how many listed streams carry them, most first (at most `topValues`). */
  values: Array<{ value: string; streams: number }>
  idLike: boolean
}

/**
 * Per-label stats of a stream listing (one /series call for a group): distinct
 * values, streams carrying the label, streams left without it, and the ID-like
 * check. Sorted by distinct values, most first.
 */
export function labelStatsFromStreams(series: Array<Record<string, string>>, { topValues = 25 } = {}): GroupLabelStat[] {
  const byLabel = new Map<string, Map<string, number>>()
  for (const stream of series) {
    for (const [label, value] of Object.entries(stream)) {
      if (isInternalLabel(label)) continue
      const values = byLabel.get(label) ?? new Map<string, number>()
      values.set(value, (values.get(value) ?? 0) + 1)
      byLabel.set(label, values)
    }
  }
  const total = new Set(series.map((stream) => JSON.stringify(Object.entries(stream).filter(([name]) => !isInternalLabel(name)).sort(([a], [b]) => a.localeCompare(b))))).size
  return Array.from(byLabel.entries())
    .map(([label, values]) => {
      const sorted = Array.from(values.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, streams]) => ({ value, streams }))
      return {
        label,
        distinctValues: values.size,
        streams: sorted.reduce((sum, item) => sum + item.streams, 0),
        streamsIfDropped: Math.min(total, streamsWithoutLabel(series, label)),
        values: sorted.slice(0, topValues),
        idLike: detectIdLike(sorted.slice(0, 200).map((item) => item.value)) !== null,
      }
    })
    .sort((a, b) => b.distinctValues - a.distinctValues || a.label.localeCompare(b.label))
}
