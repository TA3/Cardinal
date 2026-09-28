// Plain-words definitions of the terms Cardinal uses. The glossary drawer lists
// every entry; pages show `short` as an inline tooltip where the term appears.

export interface GlossaryEntry {
  term: string
  /** One sentence, fit for a tooltip. */
  short: string
  /** A few sentences for the glossary drawer. */
  long: string
}

export const GLOSSARY = {
  activeSeries: {
    term: "Active series",
    short: "A unique metric name plus label set that received samples recently. Hosted Prometheus bills by these.",
    long: "Every distinct combination of metric name and label values is one time series. It counts as active while it keeps receiving samples (about the last 20 minutes in Prometheus' head block). Memory use in Prometheus and the bill in Grafana Cloud both scale with active series, not with the number of samples.",
  },
  cardinality: {
    term: "Cardinality",
    short: "How many distinct series a metric produces, or how many distinct values a label takes.",
    long: "A metric's cardinality is the number of series it produces; a label's cardinality is the number of distinct values it takes. A label holding request IDs, user IDs or full URLs has unbounded cardinality and multiplies the series of every metric it is on.",
  },
  relabelVsAggregation: {
    term: "Relabel vs aggregation",
    short: "Relabelling edits or drops each series on its own; aggregation combines several series into one.",
    long: "Relabel rules (Prometheus metric_relabel_configs, Alloy prometheus.relabel) look at one series at a time: they can drop it or rewrite its labels, but they can't combine series. Aggregation (a recording rule, or Adaptive Metrics on Grafana Cloud) sums or counts series that end up with the same labels, so it can safely remove a label that tells series apart.",
  },
  metricVsWriteRelabel: {
    term: "metric_relabel_configs vs write_relabel_configs",
    short: "metric_relabel_configs runs at scrape time, before local storage; write_relabel_configs only filters what remote_write sends.",
    long: "metric_relabel_configs sits in a scrape config and runs on every scraped sample before Prometheus stores it, so dropped series disappear everywhere. write_relabel_configs sits in a remote_write entry and only affects what is shipped to the remote backend: Prometheus keeps the full data locally while the remote bill goes down.",
  },
  dropVsAggregate: {
    term: "Drop vs aggregate",
    short: "Dropping deletes series outright; aggregating keeps their sum or count without the dropped labels.",
    long: "Dropping a metric (or some of its series) removes the data: queries on it return nothing. Aggregating keeps the metric but stores it with fewer labels, summing (or counting) the series that collapse together, so dashboards that don't use the removed labels keep working.",
  },
  mergesSeries: {
    term: "Merges series",
    short: "Removing the label makes distinct series identical, so several series become one.",
    long: "If two series differ only by the label you remove, they end up with the same labels. A relabel drop then keeps one of their samples each scrape and rejects the others as duplicates, so their values are lost. You can instead keep only one value of the label (the other series are dropped whole), or aggregate: sum the merged series with a recording rule on remote write, or with Adaptive Metrics on Grafana Cloud.",
  },
  adaptiveMetrics: {
    term: "Adaptive Metrics",
    short: "Grafana Cloud's server-side aggregation: it merges series by dropping labels, and recommends rules from actual usage.",
    long: "Adaptive Metrics is a Grafana Cloud feature that aggregates incoming series before they are stored, based on rules you apply. It also recommends rules by looking at which labels your dashboards, alerts and queries actually use. You still send the raw series, but pay for the aggregated ones.",
  },
  histogramBuckets: {
    term: "Histogram buckets",
    short: "A classic histogram stores one _bucket series per le boundary, plus _sum and _count.",
    long: "A classic Prometheus histogram `x` is stored as `x_bucket` (one series per upper bound `le`, cumulative, ending at `+Inf`), `x_sum` and `x_count`. histogram_quantile needs the buckets, including `+Inf`. Dropping the `le` label breaks the histogram; keeping only the buckets you query (for example the ones near your SLO threshold) cuts series while keeping quantiles usable.",
  },
  logStream: {
    term: "Log stream",
    short: "In Loki, every unique set of labels is one stream. High-cardinality labels multiply streams.",
    long: "Loki indexes labels, not log lines: each distinct label set is a stream with its own chunks. A label holding request IDs, user IDs or pod hashes creates a stream per value, which bloats the index, produces many tiny chunks and runs into the per-tenant max_streams limit.",
  },
  structuredMetadata: {
    term: "Structured metadata",
    short: "Key-value pairs stored with each log line but not indexed (Loki 3.x). Still queryable, without creating streams.",
    long: "Moving a high-cardinality label (trace_id, request_id, pod) from the stream labels to structured metadata keeps it attached to every line and filterable in LogQL (`| trace_id=\"…\"`), but it no longer splits streams. It is the usual fix for a label that multiplies streams.",
  },
  chunk: {
    term: "Chunk",
    short: "A compressed block of one stream's log lines. Many small chunks mean slow queries and a large index.",
    long: "Loki appends each stream's lines to a chunk and flushes it to object storage when it is full or old enough. Streams that receive few lines each (the result of high-cardinality labels) flush many tiny chunks, which makes the index and every query more expensive.",
  },
  logVolume: {
    term: "Log volume",
    short: "Bytes of log lines ingested. Grafana Cloud bills logs by volume, so noisy lines cost the most.",
    long: "Volume is the size of the log lines Loki ingests, measured here from Loki's index (index/volume). Cardinal shows it 1024-based (1 GB = 1,024³ bytes). Dropping or sampling noisy lines (health checks, debug logs) cuts volume and cost; dropping labels mostly helps performance and stream limits instead.",
  },
  logPattern: {
    term: "Log pattern",
    short: "A line template Loki detects, with the varying parts replaced by <_>. It shows which kinds of lines repeat most.",
    long: "Loki's pattern ingester (Loki 3.x) groups similar lines into patterns such as `GET /health <_> 200`. Patterns with a large share of volume are good candidates to drop or sample, via a line filter built from the pattern.",
  },
  keepRule: {
    term: "Keep rule",
    short: "Protects matching log lines from your drop and sample rules, and from Adaptive Logs drops. It needs a reason.",
    long: "A keep rule selects streams (and optionally lines) that must stay, such as audit or security logs inside a noisy service. Exports narrow overlapping drops so they leave those lines alone (Alloy and Promtail get a `!~` filter or a negated matcher), Grafana Cloud Adaptive Logs gets an exemption for the streams, and projected savings drop by the bytes kept.",
  },
  adaptiveLogs: {
    term: "Adaptive Logs",
    short: "Grafana Cloud's server-side log sampling: it groups lines into patterns and recommends drop rates from how often queries read them.",
    long: "Adaptive Logs is a Grafana Cloud feature that drops a share of matching lines as they arrive, before they are stored and billed. It recommends a drop rate per pattern from 15 days of query usage; drop rules and exemptions (streams it must never drop) can also be set by hand or from Cardinal.",
  },
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryKey = keyof typeof GLOSSARY
