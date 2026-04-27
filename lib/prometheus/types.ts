export type PrometheusStatus = "success" | "error"

export interface PrometheusResponse<T> {
  status: PrometheusStatus
  data?: T
  errorType?: string
  error?: string
  warnings?: string[]
}

export interface PrometheusLabelValuesData {
  resultType: "vector" | "matrix" | "scalar" | "string"
  result: Array<{
    metric: Record<string, string>
    value?: [number, string]
  }>
}

export interface PrometheusSeriesCountData {
  resultType: "vector"
  result: Array<{
    metric: Record<string, string>
    value: [number, string]
  }>
}

export interface PrometheusConnectionInput {
  baseUrl: string
  instanceId?: string
  token?: string
}

export interface MetricSeriesCount {
  metric: string
  seriesCount: number
}

export interface JobMetricSeries {
  job: string
  metric: string
  seriesCount: number
}

export interface MetricSummary {
  metric: string
  seriesCount: number
  percentageOfTotal: number
  topJob?: string
}

export interface JobSummary {
  job: string
  seriesCount: number
  percentageOfTotal: number
  metricCount: number
}

export interface JobMetricSummary {
  job: string
  metric: string
  seriesCount: number
  percentageOfTotal: number
}

export interface LabelCardinality {
  label: string
  cardinality: number
}

export interface MetricDrilldown {
  metric: string
  labels: LabelCardinality[]
  seriesCount: number
}

export interface SnapshotResponse {
  totalSeries: number
  metricCount: number
  labelCount: number
  topN: number
  topMetrics: MetricSummary[]
  jobs: JobSummary[]
  metrics: MetricSummary[]
  failedMetrics: string[]
}

export interface SnapshotRequest {
  connection: PrometheusConnectionInput
  topN?: number
  concurrency?: number
}

export interface JobDrilldownRequest {
  connection: PrometheusConnectionInput
  job: string
}

export interface JobDrilldownResponse {
  job: string
  totalSeries: number
  metrics: JobMetricSummary[]
}

export interface MetricDrilldownRequest {
  connection: PrometheusConnectionInput
  metric: string
}

export interface GeneratedDropConfig {
  prometheusYaml: string
  alloyHcl: string
}
