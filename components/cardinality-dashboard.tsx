"use client"

import * as React from "react"
import { AlertTriangle, Layers, Terminal } from "lucide-react"

import { cn } from "@/lib/utils"
import { runWithConcurrency } from "@/lib/cardinality/concurrency"
import { fetchLabelValuesForMetricScoped } from "@/lib/prometheus/client"
import {
  buildJobDrilldownClient,
  buildMetricDrilldownClient,
  buildSnapshotClient,
} from "@/lib/cardinality/client-analysis"
import {
  computeExpectedSavings,
  toChartRows,
} from "@/lib/cardinality/dashboard-helpers"
import { generateDropConfigs } from "@/lib/cardinality/export-config"
import {
  DropRuleMode,
  DropRuleMetricInput,
  JobDrilldownResponse,
  MetricDrilldown,
  PrometheusConnectionInput,
  SnapshotResponse,
} from "@/lib/prometheus/types"
import {
  clearStoredConnection,
  getStoredConnection,
  saveStoredConnection,
} from "@/lib/storage/connection"
import {
  clearStoredDashboardSession,
  getStoredDashboardSession,
  saveStoredDashboardSession,
} from "@/lib/storage/dashboard-session"
import {
  buildPromptDataForJob,
  generateAIPrompt,
} from "@/lib/dashboard/prompt"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import { ActivitySheet } from "@/components/cardinality/activity-sheet"
import { ConnectionForm } from "@/components/cardinality/connection-form"
import { ConnectionStrip } from "@/components/cardinality/connection-strip"
import { DropRulesDialog } from "@/components/cardinality/drop-rules-dialog"
import { JobDrilldownPanel } from "@/components/cardinality/job-drilldown-panel"
import { JobPromptDialog } from "@/components/cardinality/job-prompt-dialog"
import { JobsTable } from "@/components/cardinality/jobs-table"
import { MetricDrilldownPanel } from "@/components/cardinality/metric-drilldown-panel"
import { RightPaneEmpty } from "@/components/cardinality/right-pane-empty"
import { StatsStrip } from "@/components/cardinality/stats-strip"
import { CardinalityFlowView } from "@/components/cardinality/cardinality-flow-view"

export function CardinalityDashboard() {
  const storedConnection = React.useMemo(() => getStoredConnection(), [])
  const storedSession = React.useMemo(() => getStoredDashboardSession(), [])

  // ── Connection form state ──────────────────────────────────────────────
  const [baseUrl, setBaseUrl] = React.useState(
    storedSession?.baseUrl ?? storedConnection?.baseUrl ?? ""
  )
  const [instanceId, setInstanceId] = React.useState(
    storedSession?.instanceId ?? storedConnection?.instanceId ?? ""
  )
  const [token, setToken] = React.useState(
    storedSession?.token ?? storedConnection?.token ?? ""
  )
  const [rememberConnection, setRememberConnection] = React.useState(
    storedSession?.rememberConnection ?? storedConnection?.remember ?? false
  )
  const [topN, setTopN] = React.useState(storedSession?.topN ?? 20)
  const [connectionExpanded, setConnectionExpanded] = React.useState(
    storedSession?.connectionExpanded ?? true
  )

  // ── Analysis state ─────────────────────────────────────────────────────
  const [error, setError] = React.useState<string | null>(null)
  const [snapshot, setSnapshot] = React.useState<SnapshotResponse | null>(
    storedSession?.snapshot ?? null
  )
  const [isLoadingSnapshot, setIsLoadingSnapshot] = React.useState(false)

  const [selectedJob, setSelectedJob] = React.useState<string | null>(
    storedSession?.selectedJob ?? null
  )
  const [jobDrilldown, setJobDrilldown] =
    React.useState<JobDrilldownResponse | null>(
      storedSession?.jobDrilldown ?? null
    )
  const [isLoadingJob, setIsLoadingJob] = React.useState(false)

  const [selectedMetric, setSelectedMetric] = React.useState<string | null>(
    storedSession?.selectedMetric ?? null
  )
  const [metricDrilldown, setMetricDrilldown] =
    React.useState<MetricDrilldown | null>(storedSession?.metricDrilldown ?? null)
  const [isLoadingMetric, setIsLoadingMetric] = React.useState(false)

  // "job" | "metric" | null — which drilldown is shown in the right panel
  const [activePanel, setActivePanel] = React.useState<
    "job" | "metric" | null
  >(storedSession?.activePanel ?? null)
  // When set, keeps the selected job context active across drilldowns
  const [filterByJob, setFilterByJob] = React.useState<string | null>(
    storedSession?.filterByJob ?? null
  )
  // Tracks whether the left pane is showing metric details instead of jobs list
  const [showMetricInLeftPane, setShowMetricInLeftPane] = React.useState(
    storedSession?.showMetricInLeftPane ?? false
  )

  // ── Drop list state ─────────────────────────────────────────────────────
  const [dropMetrics, setDropMetrics] = React.useState<string[]>(
    storedSession?.dropMetrics ?? []
  )
  const [selectedLabelsByMetric, setSelectedLabelsByMetric] = React.useState<
    Record<string, string[]>
  >(storedSession?.selectedLabelsByMetric ?? {})

  // ── Cached metric preview state ────────────────────────────────────────
  const [expandedMetricPreviews, setExpandedMetricPreviews] = React.useState<
    string[]
  >(storedSession?.expandedMetricPreviews ?? [])
  const [metricPreviewCache, setMetricPreviewCache] = React.useState<
    Record<string, MetricDrilldown>
  >(storedSession?.metricPreviewCache ?? {})
  const [metricPreviewLoading, setMetricPreviewLoading] = React.useState<
    Record<string, boolean>
  >({})
  const [metricPreviewErrors, setMetricPreviewErrors] = React.useState<
    Record<string, string>
  >(storedSession?.metricPreviewErrors ?? {})
  const [labelValuesCache, setLabelValuesCache] = React.useState<
    Record<string, string[]>
  >({})
  const [labelValuesLoading, setLabelValuesLoading] = React.useState<
    Record<string, boolean>
  >({})

  // ── UI overlay state ────────────────────────────────────────────────────
  const [activityLog, setActivityLog] = React.useState<string[]>(
    storedSession?.activityLog ?? []
  )
  const [activitySheetOpen, setActivitySheetOpen] = React.useState(false)
  const [dropRulesOpen, setDropRulesOpen] = React.useState(false)
  const [jobPromptOpen, setJobPromptOpen] = React.useState(false)
  const [jobPromptJob, setJobPromptJob] = React.useState<string | null>(null)
  const [jobPromptText, setJobPromptText] = React.useState("")
  const [isGeneratingJobPrompt, setIsGeneratingJobPrompt] = React.useState(false)
  const [dropRuleMode, setDropRuleMode] =
    React.useState<DropRuleMode>(storedSession?.dropRuleMode ?? "combined")
  const [viewMode, setViewMode] = React.useState<"table" | "flow">(
    storedSession?.viewMode ?? "table"
  )
  const [topMetricsPerJobInFlow, setTopMetricsPerJobInFlow] = React.useState(
    storedSession?.topMetricsPerJobInFlow ?? 10
  )
  const [copiedYaml, setCopiedYaml] = React.useState(false)
  const [copiedHcl, setCopiedHcl] = React.useState(false)
  const [copiedPrompt, setCopiedPrompt] = React.useState(false)

  // ── Derived values ──────────────────────────────────────────────────────
  const connection = React.useMemo<PrometheusConnectionInput | null>(() => {
    if (!baseUrl) return null
    return {
      baseUrl: baseUrl.trim(),
      instanceId: instanceId.trim() || undefined,
      token: token || undefined,
    }
  }, [baseUrl, instanceId, token])

  const exportMetrics = React.useMemo<DropRuleMetricInput[]>(() => {
    const metricNames = Array.from(
      new Set([
        ...dropMetrics,
        ...Object.keys(selectedLabelsByMetric).filter(
          (metric) => (selectedLabelsByMetric[metric] ?? []).length > 0
        ),
      ])
    )

    return metricNames.map((metric) => ({
      metric,
      topJob: snapshot?.metrics.find((item) => item.metric === metric)?.topJob,
      dropMetric: dropMetrics.includes(metric),
      droppedLabels: selectedLabelsByMetric[metric] ?? [],
    }))
  }, [dropMetrics, selectedLabelsByMetric, snapshot])

  const selectedLabelCount = React.useMemo(
    () => Object.values(selectedLabelsByMetric).reduce((sum, labels) => sum + labels.length, 0),
    [selectedLabelsByMetric]
  )

  const hasExportSelection = dropMetrics.length > 0 || selectedLabelCount > 0

  const generatedConfigs = React.useMemo(
    () => generateDropConfigs(exportMetrics, dropRuleMode),
    [dropRuleMode, exportMetrics]
  )

  const savings = React.useMemo(
    () =>
      computeExpectedSavings(
        dropMetrics,
        snapshot,
        selectedLabelsByMetric,
        {
          ...metricPreviewCache,
          ...(metricDrilldown ? { [metricDrilldown.metric]: metricDrilldown } : {}),
        }
      ),
    [dropMetrics, metricDrilldown, metricPreviewCache, selectedLabelsByMetric, snapshot]
  )

  const isCorsOrPreflightError =
    typeof error === "string" && error.includes("CORS_OR_PREFLIGHT")

  const authMode = instanceId.trim() || token ? "Basic Auth" : "Anonymous"

  const chartRows = toChartRows(snapshot)

  // ── Helpers ─────────────────────────────────────────────────────────────
  function appendLog(message: string) {
    const now = new Date().toLocaleTimeString()
    setActivityLog((prev) => [`[${now}] ${message}`, ...prev].slice(0, 30))
  }

  React.useEffect(() => {
    const hasPersistableSession =
      baseUrl.trim().length > 0 ||
      snapshot !== null ||
      activityLog.length > 0 ||
      selectedJob !== null ||
      selectedMetric !== null ||
      dropMetrics.length > 0 ||
      Object.keys(selectedLabelsByMetric).length > 0

    if (!hasPersistableSession) {
      clearStoredDashboardSession()
      return
    }

    saveStoredDashboardSession({
      baseUrl,
      instanceId,
      token,
      rememberConnection,
      topN,
      connectionExpanded,
      snapshot,
      selectedJob,
      jobDrilldown,
      selectedMetric,
      metricDrilldown,
      activePanel,
      filterByJob,
      showMetricInLeftPane,
      dropMetrics,
      selectedLabelsByMetric,
      expandedMetricPreviews,
      metricPreviewCache,
      metricPreviewErrors,
      activityLog,
      dropRuleMode,
      viewMode,
      topMetricsPerJobInFlow,
    })
  }, [
    activePanel,
    activityLog,
    baseUrl,
    connectionExpanded,
    dropMetrics,
    dropRuleMode,
    expandedMetricPreviews,
    filterByJob,
    instanceId,
    jobDrilldown,
    metricDrilldown,
    metricPreviewCache,
    metricPreviewErrors,
    rememberConnection,
    selectedJob,
    selectedLabelsByMetric,
    selectedMetric,
    showMetricInLeftPane,
    snapshot,
    token,
    topN,
    topMetricsPerJobInFlow,
    viewMode,
  ])

  // ── Event handlers ──────────────────────────────────────────────────────
  async function runSnapshot() {
    if (!connection) {
      setError("Prometheus base URL is required")
      return
    }
    setError(null)
    setIsLoadingSnapshot(true)
    setActivitySheetOpen(true)
    setConnectionExpanded(false)
    appendLog(`Starting snapshot analysis against ${connection.baseUrl}`)
    try {
      if (rememberConnection) {
        saveStoredConnection({ baseUrl, instanceId, token, remember: true })
      } else {
        clearStoredConnection()
      }
      const data = await buildSnapshotClient(connection, topN, 10, {
        onProgress: appendLog,
      })
      setSnapshot(data)
      appendLog(
        `Snapshot loaded: ${data.totalSeries.toLocaleString()} active series across ${data.metricCount.toLocaleString()} metrics`
      )
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load snapshot"
      setError(message)
      appendLog(`Snapshot error: ${message}`)
    } finally {
      setIsLoadingSnapshot(false)
    }
  }

  async function loadJobDrilldown(job: string) {
    if (!connection) return
    setSelectedJob(job)
    setActivePanel("job")
    setFilterByJob(job)
    setShowMetricInLeftPane(false)
    setIsLoadingJob(true)
    appendLog(`Loading job drilldown for ${job}`)
    try {
      const data = await buildJobDrilldownClient(connection, job, {
        onProgress: appendLog,
      })
      setJobDrilldown(data)
      appendLog(`Loaded ${data.metrics.length.toLocaleString()} metrics for job ${job}`)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed job drilldown"
      setError(message)
      appendLog(`Job drilldown error: ${message}`)
    } finally {
      setIsLoadingJob(false)
    }
  }

  async function loadMetricDrilldown(metric: string, fromJob = false) {
    if (!connection) return
    setSelectedMetric(metric)
    setActivePanel(fromJob ? "job" : "metric")
    setShowMetricInLeftPane(fromJob)
    setIsLoadingMetric(true)
    appendLog(`Loading metric drilldown for ${metric}`)
    try {
      const data = await buildMetricDrilldownClient(connection, metric, {
        onProgress: appendLog,
      })
      setMetricDrilldown(data)
      appendLog(`Loaded label split for ${metric}`)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed metric drilldown"
      setError(message)
      appendLog(`Metric drilldown error: ${message}`)
    } finally {
      setIsLoadingMetric(false)
    }
  }

  function toggleDropMetric(metric: string) {
    setDropMetrics((prev) =>
      prev.includes(metric)
        ? prev.filter((m) => m !== metric)
        : [...prev, metric]
    )
  }

  function clearAllDropMetrics() {
    setDropMetrics([])
    setSelectedLabelsByMetric({})
  }

  function clearMetricExportSelection(metric: string) {
    setDropMetrics((prev) => prev.filter((item) => item !== metric))
    setSelectedLabelsByMetric((prev) => {
      const rest = { ...prev }
      delete rest[metric]
      return rest
    })
  }

  function toggleDropLabel(metric: string, label: string) {
    setSelectedLabelsByMetric((prev) => {
      const current = prev[metric] ?? []
      const next = current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label].sort((a, b) => a.localeCompare(b))

      if (next.length === 0) {
        const rest = { ...prev }
        delete rest[metric]
        return rest
      }

      return {
        ...prev,
        [metric]: next,
      }
    })
  }

  async function toggleMetricPreview(metric: string) {
    const isExpanded = expandedMetricPreviews.includes(metric)
    if (isExpanded) {
      setExpandedMetricPreviews((prev) => prev.filter((item) => item !== metric))
      return
    }

    setExpandedMetricPreviews((prev) => [...prev, metric])
    if (!connection || metricPreviewCache[metric] || metricPreviewLoading[metric]) {
      return
    }

    setMetricPreviewLoading((prev) => ({ ...prev, [metric]: true }))
    setMetricPreviewErrors((prev) => {
      const rest = { ...prev }
      delete rest[metric]
      return rest
    })

    try {
      const data = await buildMetricDrilldownClient(connection, metric)
      setMetricPreviewCache((prev) => ({ ...prev, [metric]: data }))
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load label split"
      setMetricPreviewErrors((prev) => ({ ...prev, [metric]: message }))
    } finally {
      setMetricPreviewLoading((prev) => ({ ...prev, [metric]: false }))
    }
  }

  async function toggleMetricLabelsInFlow(metric: string) {
    await toggleMetricPreview(metric)
  }

  async function fetchLabelValuesForMetric(metric: string, label: string) {
    if (!connection) {
      return
    }

    const cacheKey = `${metric}::${label}`
    if (cacheKey in labelValuesCache || labelValuesLoading[cacheKey]) {
      return
    }

    setLabelValuesLoading((prev) => ({ ...prev, [cacheKey]: true }))
    try {
      const values = await fetchLabelValuesForMetricScoped(connection, metric, label)
      setLabelValuesCache((prev) => ({ ...prev, [cacheKey]: values }))
    } catch {
      setLabelValuesCache((prev) => ({ ...prev, [cacheKey]: [] }))
    } finally {
      setLabelValuesLoading((prev) => {
        const next = { ...prev }
        delete next[cacheKey]
        return next
      })
    }
  }

  async function generateJobPromptForJob(job: string) {
    if (!connection || !snapshot) {
      return
    }

    setJobPromptOpen(true)
    setJobPromptJob(job)
    setCopiedPrompt(false)
    setIsGeneratingJobPrompt(true)
    appendLog(`Generating AI dashboard prompt for job '${job}'`)

    try {
      const drilldown =
        selectedJob === job && jobDrilldown
          ? jobDrilldown
          : await buildJobDrilldownClient(connection, job)

      const topMetrics = drilldown.metrics.slice(0, 20)
      const metricsNeedingLabels = topMetrics
        .map((metric) => metric.metric)
        .filter(
          (metric) =>
            !metricPreviewCache[metric] && metricDrilldown?.metric !== metric
        )

      const fetchedLabelData = await runWithConcurrency(
        metricsNeedingLabels,
        async (metric) => {
          try {
            return await buildMetricDrilldownClient(connection, metric)
          } catch {
            return null
          }
        },
        4
      )

      const fetchedMap = fetchedLabelData.reduce<Record<string, MetricDrilldown>>(
        (acc, row) => {
          if (row) {
            acc[row.metric] = row
          }
          return acc
        },
        {}
      )

      if (Object.keys(fetchedMap).length > 0) {
        setMetricPreviewCache((prev) => ({ ...prev, ...fetchedMap }))
      }

      const allMetricDrilldowns: Record<string, MetricDrilldown | undefined> = {
        ...metricPreviewCache,
        ...(metricDrilldown ? { [metricDrilldown.metric]: metricDrilldown } : {}),
        ...fetchedMap,
      }

      const promptData = buildPromptDataForJob(drilldown, allMetricDrilldowns, 20)
      const prompt = generateAIPrompt(promptData, { job })
      setJobPromptText(prompt)
      appendLog(
        `Generated prompt using ${promptData.totalMetrics.toLocaleString()} metrics for job '${job}'`
      )
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate job prompt"
      setJobPromptText("")
      setError(message)
      appendLog(`Prompt generation failed for '${job}'`)
    } finally {
      setIsGeneratingJobPrompt(false)
    }
  }

  function restoreJobsPane() {
    setShowMetricInLeftPane(false)
    setSelectedMetric(null)
    setMetricDrilldown(null)
    setActivePanel(selectedJob ? "job" : null)
  }

  function clearJobContext() {
    setSelectedJob(null)
    setJobDrilldown(null)
    setSelectedMetric(null)
    setMetricDrilldown(null)
    setFilterByJob(null)
    setActivePanel(null)
    setShowMetricInLeftPane(false)
    setExpandedMetricPreviews([])
  }

  function copyToClipboard(text: string, kind: "yaml" | "hcl" | "prompt") {
    void navigator.clipboard.writeText(text).then(() => {
      if (kind === "yaml") {
        setCopiedYaml(true)
        setTimeout(() => setCopiedYaml(false), 1500)
      } else if (kind === "hcl") {
        setCopiedHcl(true)
        setTimeout(() => setCopiedHcl(false), 1500)
      } else {
        setCopiedPrompt(true)
        setTimeout(() => setCopiedPrompt(false), 1500)
      }
    })
  }

  function disconnect() {
    clearStoredConnection()
    clearStoredDashboardSession()
    setBaseUrl("")
    setInstanceId("")
    setToken("")
    setRememberConnection(false)
    setTopN(20)
    setSnapshot(null)
    setJobDrilldown(null)
    setMetricDrilldown(null)
    setSelectedJob(null)
    setSelectedMetric(null)
    setDropMetrics([])
    setSelectedLabelsByMetric({})
    setError(null)
    setActivityLog([])
    setActivePanel(null)
    setFilterByJob(null)
    setShowMetricInLeftPane(false)
    setExpandedMetricPreviews([])
    setMetricPreviewCache({})
    setMetricPreviewLoading({})
    setMetricPreviewErrors({})
    setLabelValuesCache({})
    setLabelValuesLoading({})
    setDropRuleMode("combined")
    setViewMode("table")
    setTopMetricsPerJobInFlow(10)
    setDropRulesOpen(false)
    setJobPromptOpen(false)
    setJobPromptJob(null)
    setJobPromptText("")
    setIsGeneratingJobPrompt(false)
    setActivitySheetOpen(false)
    setCopiedPrompt(false)
    setConnectionExpanded(true)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <main className="relative min-h-svh bg-background">
      {/* Ambient gradient */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 top-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:14px_24px] opacity-10" />
      <div className="pointer-events-none absolute left-0 right-0 top-[-10%] h-[1000px] w-[1000px] rounded-full bg-[radial-gradient(circle_400px_at_50%_300px,#fbfbfb36,#000)] opacity-[.01]" />

      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-8 md:px-8">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Cardinal
            </h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              Analyze active series in one snapshot, spot high-cardinality
              metrics and labels, and export production-ready drop rules.
            </p>
            <p className="text-xs text-muted-foreground">
              Everything stays local in your browser. No data is sent to any server.
            </p>
            {snapshot ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={viewMode === "table" ? "default" : "outline"}
                  onClick={() => setViewMode("table")}
                >
                  Table view
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === "flow" ? "default" : "outline"}
                  onClick={() => setViewMode("flow")}
                >
                  Flow view
                </Button>
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 shrink-0"
            onClick={() => setActivitySheetOpen(true)}
          >
            <Terminal className="size-3.5" />
            Activity
          </Button>
        </header>

        {/* ── Connection ───────────────────────────────────────────────── */}
        {snapshot && !connectionExpanded ? (
          <ConnectionStrip
            baseUrl={baseUrl}
            authMode={authMode}
            isLoadingSnapshot={isLoadingSnapshot}
            onExpand={() => setConnectionExpanded(true)}
            onRefresh={() => { void runSnapshot() }}
            onDisconnect={disconnect}
          />
        ) : (
          <ConnectionForm
            baseUrl={baseUrl}
            setBaseUrl={setBaseUrl}
            instanceId={instanceId}
            setInstanceId={setInstanceId}
            token={token}
            setToken={setToken}
            rememberConnection={rememberConnection}
            setRememberConnection={setRememberConnection}
            topN={topN}
            setTopN={setTopN}
            isLoadingSnapshot={isLoadingSnapshot}
            hasSnapshot={!!snapshot}
            connection={connection}
            onSubmit={() => { void runSnapshot() }}
            onCollapse={() => setConnectionExpanded(false)}
            onDisconnect={disconnect}
          />
        )}

        {/* ── Error alerts ─────────────────────────────────────────────── */}
        {error && !isCorsOrPreflightError ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {isCorsOrPreflightError ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>Preflight / CORS configuration required</AlertTitle>
            <AlertDescription>
              Client-side mode requires Prometheus (or its ingress) to respond
              to OPTIONS preflight requests and allow the{" "}
              <code>Authorization</code> header cross-origin.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* ── Loading skeleton ─────────────────────────────────────────── */}
        {isLoadingSnapshot ? (
          <div className="grid gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        ) : null}

        {/* ── Main content ─────────────────────────────────────────────── */}
        {snapshot ? (
          <>
            <StatsStrip
              snapshot={snapshot}
              dropMetrics={dropMetrics}
              selectedLabelCount={selectedLabelCount}
              savings={savings}
            />

            {viewMode === "flow" ? (
              <CardinalityFlowView
                snapshot={snapshot}
                topMetricsPerJob={topMetricsPerJobInFlow}
                onTopMetricsPerJobChange={setTopMetricsPerJobInFlow}
                expandedMetricPreviews={expandedMetricPreviews}
                metricPreviewCache={metricPreviewCache}
                metricPreviewLoading={metricPreviewLoading}
                metricPreviewErrors={metricPreviewErrors}
                labelValuesCache={labelValuesCache}
                labelValuesLoading={labelValuesLoading}
                dropMetrics={dropMetrics}
                selectedLabelsByMetric={selectedLabelsByMetric}
                onOpenJob={(job) => {
                  void loadJobDrilldown(job)
                }}
                onOpenJobPrompt={(job) => {
                  void generateJobPromptForJob(job)
                }}
                onToggleMetricDrop={toggleDropMetric}
                onToggleLabelDrop={toggleDropLabel}
                onToggleMetricLabels={(metric) => {
                  void toggleMetricLabelsInFlow(metric)
                }}
                onFetchLabelValues={(metric, label) => {
                  void fetchLabelValuesForMetric(metric, label)
                }}
              />
            ) : null}

            {/* Two-pane layout */}
            {viewMode === "table" ? (
            <div className={cn("grid gap-6", activePanel ? "xl:grid-cols-[2fr_3fr]" : "xl:grid-cols-[3fr_2fr]")}>

              {/* LEFT PANE */}
              <div className="flex flex-col gap-6">
                {showMetricInLeftPane ? (
                  <MetricDrilldownPanel
                    selectedMetric={selectedMetric}
                    metricDrilldown={metricDrilldown}
                    isLoadingMetric={isLoadingMetric}
                    dropMetrics={dropMetrics}
                    selectedLabels={selectedMetric ? selectedLabelsByMetric[selectedMetric] ?? [] : []}
                    labelValuesCache={labelValuesCache}
                    labelValuesLoading={labelValuesLoading}
                    jobDrilldownCollapsed={false}
                    onToggleDrop={toggleDropMetric}
                    onToggleLabel={toggleDropLabel}
                    onFetchLabelValues={(metric, label) => {
                      void fetchLabelValuesForMetric(metric, label)
                    }}
                    onBackToJobs={restoreJobsPane}
                    onClearContext={clearJobContext}
                    onClose={restoreJobsPane}
                  />
                ) : (
                  <JobsTable
                    snapshot={snapshot}
                    dropMetrics={dropMetrics}
                    selectedJob={selectedJob}
                    activePanel={activePanel}
                    filterByJob={filterByJob}
                    onJobClick={(job) => { void loadJobDrilldown(job) }}
                    onGeneratePrompt={(job) => {
                      void generateJobPromptForJob(job)
                    }}
                    onClearFilter={clearJobContext}
                  />
                )}
              </div>

              {/* RIGHT PANE */}
              <div className="flex flex-col gap-4">
                {activePanel === null ? (
                  <RightPaneEmpty chartRows={chartRows} />
                ) : null}

                {activePanel === "job" ? (
                  <JobDrilldownPanel
                    selectedJob={selectedJob}
                    jobDrilldown={jobDrilldown}
                    isLoadingJob={isLoadingJob}
                    dropMetrics={dropMetrics}
                    selectedMetric={selectedMetric}
                    selectedLabelsByMetric={selectedLabelsByMetric}
                    expandedMetrics={expandedMetricPreviews}
                    metricPreviewCache={metricPreviewCache}
                    metricPreviewLoading={metricPreviewLoading}
                    metricPreviewErrors={metricPreviewErrors}
                    onMetricClick={(metric) => {
                      void loadMetricDrilldown(metric, true)
                    }}
                    onTogglePreview={(metric) => {
                      void toggleMetricPreview(metric)
                    }}
                    onToggleDrop={toggleDropMetric}
                    onClose={clearJobContext}
                  />
                ) : null}

                {activePanel === "metric" && !showMetricInLeftPane ? (
                  <MetricDrilldownPanel
                    selectedMetric={selectedMetric}
                    metricDrilldown={metricDrilldown}
                    isLoadingMetric={isLoadingMetric}
                    dropMetrics={dropMetrics}
                    selectedLabels={selectedMetric ? selectedLabelsByMetric[selectedMetric] ?? [] : []}
                    labelValuesCache={labelValuesCache}
                    labelValuesLoading={labelValuesLoading}
                    jobDrilldownCollapsed={false}
                    onToggleDrop={toggleDropMetric}
                    onToggleLabel={toggleDropLabel}
                    onFetchLabelValues={(metric, label) => {
                      void fetchLabelValuesForMetric(metric, label)
                    }}
                    onClose={() => {
                      setActivePanel(null)
                    }}
                  />
                ) : null}
              </div>
            </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/* ── Activity log sheet ─────────────────────────────────────────── */}
      <ActivitySheet
        open={activitySheetOpen}
        onOpenChange={setActivitySheetOpen}
        activityLog={activityLog}
      />

      {/* ── Drop rules FAB ─────────────────────────────────────────────── */}
      {hasExportSelection ? (
        <div className="fixed bottom-6 right-6 z-50">
          <Button
            size="lg"
            className="gap-2 rounded-full pl-5 pr-4 shadow-xl"
            onClick={() => setDropRulesOpen(true)}
          >
            <Layers className="size-4" />
            Drop Rules
            <Badge
              variant="secondary"
              className="ml-0.5 rounded-full px-2 py-0.5 text-xs"
            >
              {dropMetrics.length + selectedLabelCount}
            </Badge>
          </Button>
        </div>
      ) : null}

      {/* ── Drop rules dialog ──────────────────────────────────────────── */}
      <DropRulesDialog
        open={dropRulesOpen}
        onOpenChange={setDropRulesOpen}
        exportMetrics={exportMetrics}
        snapshot={snapshot}
        savings={savings}
        selectedLabelCount={selectedLabelCount}
        dropRuleMode={dropRuleMode}
        generatedConfigs={generatedConfigs}
        copiedYaml={copiedYaml}
        copiedHcl={copiedHcl}
        onModeChange={setDropRuleMode}
        onRemoveMetric={clearMetricExportSelection}
        onClearAll={clearAllDropMetrics}
        onCopyYaml={() => copyToClipboard(generatedConfigs.prometheusYaml, "yaml")}
        onCopyHcl={() => copyToClipboard(generatedConfigs.alloyHcl, "hcl")}
      />

      <JobPromptDialog
        open={jobPromptOpen}
        onOpenChange={setJobPromptOpen}
        job={jobPromptJob}
        promptText={jobPromptText}
        isGenerating={isGeneratingJobPrompt}
        copied={copiedPrompt}
        onGenerate={() => {
          if (!jobPromptJob) {
            return
          }
          void generateJobPromptForJob(jobPromptJob)
        }}
        onCopy={() => copyToClipboard(jobPromptText, "prompt")}
      />
    </main>
  )
}
