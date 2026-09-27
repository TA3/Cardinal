// Pure URL facts about Grafana and Grafana Cloud, shared by the sources (which
// fetch) and the Connect Grafana planning (which must stay network-free).

export type DatasourceType = "prometheus" | "loki"

export interface GrafanaDatasource {
  uid: string
  name: string
  type: DatasourceType
  /** The backend URL Grafana proxies to, when the token may see it. */
  url?: string
  isDefault: boolean
}

/** Grafana data source uids: letters, digits, "-" and "_" (the proxy allows only these). */
export const DATASOURCE_UID = /^[A-Za-z0-9_-]{1,64}$/

/** A base URL without trailing slashes; throws unless it is http(s). */
export function bareBaseUrl(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//.test(trimmed)) throw new Error("URL must start with http:// or https://")
  return trimmed
}

/** The base URL that reaches a data source through Grafana's data source proxy. */
export function datasourceProxyUrl(grafanaUrl: string, uid: string) {
  if (!DATASOURCE_UID.test(uid)) throw new Error(`Unsupported data source uid: ${JSON.stringify(uid)}`)
  return `${bareBaseUrl(grafanaUrl)}/api/datasources/proxy/uid/${uid}`
}

/**
 * Base URL of the Adaptive Metrics API for a hosted Prometheus URL such as
 * `https://prometheus-prod-01-eu-west-0.grafana.net/api/prom`, or null when the
 * URL is not one. A Grafana stack URL (`https://mystack.grafana.net`) is the
 * Grafana UI, not the metrics host, so it has no Adaptive Metrics API.
 */
export function adaptiveMetricsBaseUrl(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (!host.endsWith(".grafana.net") || !host.startsWith("prometheus-")) return null
  return `${url.protocol}//${url.host}`
}

/**
 * Base URL of the Adaptive Logs API for a hosted Loki URL such as
 * `https://logs-prod-012.grafana.net`, or null when the URL is not one (a
 * Grafana stack URL or a datasource proxy has no Adaptive Logs API).
 */
export function adaptiveLogsBaseUrl(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "https:" || !host.endsWith(".grafana.net") || !host.startsWith("logs-")) return null
  return `${url.protocol}//${url.host}`
}
