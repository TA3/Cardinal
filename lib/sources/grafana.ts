import { runWithConcurrency } from "@/lib/core/concurrency"
import { DATASOURCE_UID, datasourceProxyUrl, type DatasourceType, type GrafanaDatasource } from "@/lib/core/grafana-cloud"
import { UsageIndexBuilder, type GrafanaUsageIndex, type LibraryPanelRef } from "@/lib/core/grafana-usage"
import { HttpError, normalizeBaseUrl, sendJson, type Connection, type TransportMode } from "@/lib/sources/transport"

// Grafana as a usage source: dashboards (search, then each dashboard by uid),
// library panels, and Grafana-managed alert rules, read with a service account
// token. Everything is read-only; the proxy only allows these GET paths.

export interface GrafanaConnection {
  baseUrl: string
  /** Service account token; empty for anonymous access. */
  token?: string
  mode: TransportMode
}

export interface GrafanaScanProgress {
  phase: "Listing dashboards" | "Reading dashboards" | "Reading library panels" | "Reading alert rules"
  done: number
  total: number
}

interface SearchHit {
  uid: string
  title?: string
  url?: string
  folderTitle?: string
  type?: string
}

interface DashboardResponse {
  dashboard: unknown
  meta?: { url?: string; folderTitle?: string }
}

const PAGE_SIZE = 1000
const MAX_PAGES = 50
const DEFAULT_CONCURRENCY = 6

function transport(grafana: GrafanaConnection): Connection {
  const token = grafana.token?.trim()
  return { baseUrl: normalizeBaseUrl(grafana.baseUrl), auth: token ? "bearer" : "none", token: token || undefined, mode: grafana.mode }
}

/**
 * Retries rate limits (the Cardinal proxy allows 600 requests a minute) and
 * gateway hiccups with a growing pause, so a large Grafana still scans fully.
 */
async function withRetry<T>(work: () => Promise<T>, signal?: AbortSignal, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      const retryable = error instanceof HttpError && [429, 502, 503, 504].includes(error.status) && error.proxyFailure !== "private"
      if (!retryable || attempt >= attempts) throw error
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(20_000, 1_500 * 2 ** (attempt - 1)))
        signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true })
      })
    }
  }
}

const isAbort = (error: unknown) => error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface GrafanaCheck {
  latencyMs: number
  /** False when the token sees no dashboards at all. */
  anyDashboards: boolean
}

/** One search request: proves the URL is a Grafana API and the token can list dashboards. */
export async function testGrafana(grafana: GrafanaConnection, signal?: AbortSignal): Promise<GrafanaCheck> {
  const started = performance.now()
  const hits = await sendJson<unknown>(transport(grafana), { path: "/api/search", query: { type: "dash-db", limit: "1" }, signal })
  if (!Array.isArray(hits)) throw new Error("That URL answered, but not like the Grafana API (/api/search didn't return a list). Use the Grafana root URL.")
  return { latencyMs: Math.round(performance.now() - started), anyDashboards: hits.length > 0 }
}

/** Every dashboard the token can see, page by page. */
export async function listDashboards(grafana: GrafanaConnection, signal?: AbortSignal): Promise<SearchHit[]> {
  const connection = transport(grafana)
  const hits: SearchHit[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await withRetry(
      () =>
        sendJson<SearchHit[]>(connection, {
          path: "/api/search",
          query: { type: "dash-db", limit: String(PAGE_SIZE), page: String(page) },
          signal,
        }),
      signal
    )
    if (!Array.isArray(batch)) throw new Error("Grafana's search API didn't return a list.")
    hits.push(...batch.filter((hit) => typeof hit?.uid === "string" && (hit.type === undefined || hit.type === "dash-db")))
    if (batch.length < PAGE_SIZE) break
  }
  return Array.from(new Map(hits.map((hit) => [hit.uid, hit])).values())
}

export function fetchDashboard(grafana: GrafanaConnection, uid: string, signal?: AbortSignal) {
  return sendJson<DashboardResponse>(transport(grafana), { path: `/api/dashboards/uid/${encodeURIComponent(uid)}`, signal })
}

export async function fetchLibraryPanelModel(grafana: GrafanaConnection, uid: string, signal?: AbortSignal): Promise<unknown> {
  const response = await sendJson<{ result?: { model?: unknown } }>(transport(grafana), {
    path: `/api/library-elements/${encodeURIComponent(uid)}`,
    signal,
  })
  return response.result?.model
}

/**
 * Grafana-managed alert rules. The provisioning API needs alert.provisioning:read
 * (Admin by default); the ruler API works for Viewers, so it is the fallback.
 */
export async function fetchAlertRules(grafana: GrafanaConnection, signal?: AbortSignal): Promise<unknown> {
  const connection = transport(grafana)
  try {
    return await sendJson<unknown>(connection, { path: "/api/v1/provisioning/alert-rules", signal })
  } catch (error) {
    if (!(error instanceof HttpError) || ![401, 403, 404].includes(error.status)) throw error
    return sendJson<unknown>(connection, { path: "/api/ruler/grafana/api/v1/rules", signal })
  }
}

/**
 * Reads every dashboard, library panel and Grafana-managed alert rule into a
 * usage index. A dashboard that fails is recorded as a problem; listing
 * failures and aborts reject.
 */
export async function scanGrafana(
  grafana: GrafanaConnection,
  options: { signal?: AbortSignal; onProgress?: (progress: GrafanaScanProgress) => void; concurrency?: number } = {}
): Promise<GrafanaUsageIndex> {
  const { signal, onProgress } = options
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const baseUrl = normalizeBaseUrl(grafana.baseUrl)
  const builder = new UsageIndexBuilder(baseUrl)

  onProgress?.({ phase: "Listing dashboards", done: 0, total: 0 })
  const hits = await listDashboards(grafana, signal)

  const libraries: LibraryPanelRef[] = []
  let done = 0
  onProgress?.({ phase: "Reading dashboards", done, total: hits.length })
  await runWithConcurrency(
    hits,
    async (hit) => {
      try {
        const { dashboard, meta } = await withRetry(() => fetchDashboard(grafana, hit.uid, signal), signal)
        libraries.push(...builder.addDashboard(dashboard, { url: meta?.url ?? hit.url, folder: meta?.folderTitle ?? hit.folderTitle }))
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error
        builder.problem(hit.title ?? hit.uid, message(error), hit.url)
      }
      done += 1
      onProgress?.({ phase: "Reading dashboards", done, total: hits.length })
    },
    concurrency,
    signal
  )

  const libraryUids = Array.from(new Set(libraries.map((ref) => ref.uid)))
  if (libraryUids.length) {
    done = 0
    onProgress?.({ phase: "Reading library panels", done, total: libraryUids.length })
    const models = new Map<string, unknown>()
    await runWithConcurrency(
      libraryUids,
      async (uid) => {
        try {
          models.set(uid, await withRetry(() => fetchLibraryPanelModel(grafana, uid, signal), signal))
        } catch (error) {
          if (isAbort(error) || signal?.aborted) throw error
          const ref = libraries.find((item) => item.uid === uid)
          builder.problem(`Library panel ${ref?.name ?? uid}`, message(error))
        }
        done += 1
        onProgress?.({ phase: "Reading library panels", done, total: libraryUids.length })
      },
      concurrency,
      signal
    )
    for (const ref of libraries) if (models.has(ref.uid)) builder.addLibraryPanel(ref, models.get(ref.uid))
  }

  onProgress?.({ phase: "Reading alert rules", done: 0, total: 0 })
  try {
    builder.addAlertRules(await withRetry(() => fetchAlertRules(grafana, signal), signal))
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw error
    builder.setAlertsError(message(error))
  }
  signal?.throwIfAborted()
  return builder.build()
}

export { DATASOURCE_UID, datasourceProxyUrl, type DatasourceType, type GrafanaDatasource }

/** Prometheus and Loki data sources the token can see, defaults first. */
export async function listDatasources(grafana: GrafanaConnection, signal?: AbortSignal): Promise<GrafanaDatasource[]> {
  const body = await sendJson<unknown>(transport(grafana), { path: "/api/datasources", signal })
  if (!Array.isArray(body)) throw new Error("That URL answered, but not like the Grafana API (/api/datasources didn't return a list). Use the Grafana root URL.")
  return (body as Array<Record<string, unknown>>)
    .filter((item) => (item.type === "prometheus" || item.type === "loki") && typeof item.uid === "string" && DATASOURCE_UID.test(item.uid))
    .map((item) => ({
      uid: item.uid as string,
      name: typeof item.name === "string" ? item.name : (item.uid as string),
      type: item.type as DatasourceType,
      url: typeof item.url === "string" && item.url ? item.url : undefined,
      isDefault: item.isDefault === true,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

/** Whether a dashboard with this uid exists (404 → false). */
export async function dashboardExists(grafana: GrafanaConnection, uid: string, signal?: AbortSignal): Promise<{ exists: boolean; title?: string; url?: string }> {
  try {
    const { dashboard, meta } = await fetchDashboard(grafana, uid, signal)
    return { exists: true, title: (dashboard as { title?: string } | null)?.title, url: meta?.url }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return { exists: false }
    throw error
  }
}

export interface CreatedDashboard {
  uid: string
  /** Grafana's path to it, e.g. /d/cardinal-overview/cardinal-overview. */
  url: string
}

/**
 * Creates (or, with `overwrite`, replaces) a dashboard: POST /api/dashboards/db,
 * which needs the Editor role. Without `overwrite` Grafana refuses an existing uid (HTTP 412).
 */
export async function createDashboard(
  grafana: GrafanaConnection,
  dashboard: Record<string, unknown>,
  options: { overwrite: boolean; message?: string }
): Promise<CreatedDashboard> {
  const response = await sendJson<{ uid?: string; url?: string }>(transport(grafana), {
    path: "/api/dashboards/db",
    method: "POST",
    body: { dashboard: { ...dashboard, id: null }, overwrite: options.overwrite, message: options.message ?? "Created by Cardinal" },
  })
  return { uid: response.uid ?? String(dashboard.uid), url: response.url ?? `/d/${String(dashboard.uid)}` }
}
