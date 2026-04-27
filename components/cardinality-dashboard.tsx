"use client"

import * as React from "react"
import { AlertTriangle, ChevronRight, Database, Layers, Terminal } from "lucide-react"

import { cn } from "@/lib/utils"
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

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import { ActivitySheet } from "@/components/cardinality/activity-sheet"
import { ConnectionForm } from "@/components/cardinality/connection-form"
import { ConnectionStrip } from "@/components/cardinality/connection-strip"
import { DropRulesDialog } from "@/components/cardinality/drop-rules-dialog"
import { JobDrilldownPanel } from "@/components/cardinality/job-drilldown-panel"
import { JobsTable } from "@/components/cardinality/jobs-table"
import { MetricDrilldownPanel } from "@/components/cardinality/metric-drilldown-panel"
import { MetricsTable } from "@/components/cardinality/metrics-table"
import { RightPaneEmpty } from "@/components/cardinality/right-pane-empty"
import { StatsStrip } from "@/components/cardinality/stats-strip"

export function CardinalityDashboard() {
  const storedConnection = React.useMemo(() => getStoredConnection(), [])

  // ── Connection form state ──────────────────────────────────────────────
  const [baseUrl, setBaseUrl] = React.useState(storedConnection?.baseUrl ?? "")
  const [instanceId, setInstanceId] = React.useState(
    storedConnection?.instanceId ?? ""
  )
  const [token, setToken] = React.useState(storedConnection?.token ?? "")
  const [rememberConnection, setRememberConnection] = React.useState(
    storedConnection?.remember ?? false
  )
  const [topN, setTopN] = React.useState(20)
  const [connectionExpanded, setConnectionExpanded] = React.useState(true)

  // ── Analysis state ─────────────────────────────────────────────────────
  const [error, setError] = React.useState<string | null>(null)
  const [snapshot, setSnapshot] = React.useState<SnapshotResponse | null>(null)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = React.useState(false)

  const [selectedJob, setSelectedJob] = React.useState<string | null>(null)
  const [jobDrilldown, setJobDrilldown] =
    React.useState<JobDrilldownResponse | null>(null)
  const [isLoadingJob, setIsLoadingJob] = React.useState(false)

  const [selectedMetric, setSelectedMetric] = React.useState<string | null>(null)
  const [metricDrilldown, setMetricDrilldown] =
    React.useState<MetricDrilldown | null>(null)
  const [isLoadingMetric, setIsLoadingMetric] = React.useState(false)

  // "job" | "metric" | null — which drilldown is shown in the right panel
  const [activePanel, setActivePanel] = React.useState<
    "job" | "metric" | null
  >(null)
  // When set, filters the metrics table to only show metrics from this job
  const [filterByJob, setFilterByJob] = React.useState<string | null>(null)
  // When true, job drilldown collapses to a strip while metric drilldown is shown
  const [jobDrilldownCollapsed, setJobDrilldownCollapsed] = React.useState(false)

  // ── Drop list state ─────────────────────────────────────────────────────
  const [dropMetrics, setDropMetrics] = React.useState<string[]>([])

  // ── UI overlay state ────────────────────────────────────────────────────
  const [activityLog, setActivityLog] = React.useState<string[]>([])
  const [activitySheetOpen, setActivitySheetOpen] = React.useState(false)
  const [dropRulesOpen, setDropRulesOpen] = React.useState(false)
  const [copiedYaml, setCopiedYaml] = React.useState(false)
  const [copiedHcl, setCopiedHcl] = React.useState(false)

  // ── Derived values ──────────────────────────────────────────────────────
  const connection = React.useMemo<PrometheusConnectionInput | null>(() => {
    if (!baseUrl) return null
    return {
      baseUrl: baseUrl.trim(),
      instanceId: instanceId.trim() || undefined,
      token: token || undefined,
    }
  }, [baseUrl, instanceId, token])

  const generatedConfigs = React.useMemo(
    () => generateDropConfigs(dropMetrics),
    [dropMetrics]
  )

  const savings = React.useMemo(
    () => computeExpectedSavings(dropMetrics, snapshot),
    [dropMetrics, snapshot]
  )

  const isCorsOrPreflightError =
    typeof error === "string" && error.includes("CORS_OR_PREFLIGHT")

  const authMode = instanceId.trim() || token ? "Basic Auth" : "Anonymous"

  const visibleMetrics = React.useMemo(() => {
    if (!snapshot) return []
    if (!filterByJob) return snapshot.topMetrics
    return snapshot.topMetrics.filter((m) => m.topJob === filterByJob)
  }, [snapshot, filterByJob])

  const chartRows = toChartRows(snapshot)

  // ── Helpers ─────────────────────────────────────────────────────────────
  function appendLog(message: string) {
    const now = new Date().toLocaleTimeString()
    setActivityLog((prev) => [`[${now}] ${message}`, ...prev].slice(0, 30))
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  async function runSnapshot() {
    if (!connection) {
      setError("Prometheus base URL is required")
      return
    }
    setError(null)
    setIsLoadingSnapshot(true)
    setConnectionExpanded(false)
    appendLog("Starting snapshot analysis in browser")
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
    setIsLoadingJob(true)
    try {
      const data = await buildJobDrilldownClient(connection, job, {
        onProgress: appendLog,
      })
      setJobDrilldown(data)
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
    setActivePanel("metric")
    if (fromJob) setJobDrilldownCollapsed(true)
    setIsLoadingMetric(true)
    try {
      const data = await buildMetricDrilldownClient(connection, metric, {
        onProgress: appendLog,
      })
      setMetricDrilldown(data)
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

  function dropTop5() {
    const top5 = visibleMetrics.slice(0, 5).map((m) => m.metric)
    setDropMetrics((prev) => Array.from(new Set([...prev, ...top5])))
  }

  function clearAllDropMetrics() {
    setDropMetrics([])
  }

  function copyToClipboard(text: string, kind: "yaml" | "hcl") {
    void navigator.clipboard.writeText(text).then(() => {
      if (kind === "yaml") {
        setCopiedYaml(true)
        setTimeout(() => setCopiedYaml(false), 1500)
      } else {
        setCopiedHcl(true)
        setTimeout(() => setCopiedHcl(false), 1500)
      }
    })
  }

  function disconnect() {
    clearStoredConnection()
    setSnapshot(null)
    setJobDrilldown(null)
    setMetricDrilldown(null)
    setSelectedJob(null)
    setSelectedMetric(null)
    setDropMetrics([])
    setError(null)
    setActivityLog([])
    setActivePanel(null)
    setFilterByJob(null)
    setJobDrilldownCollapsed(false)
    setConnectionExpanded(true)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <main className="relative min-h-svh bg-background">
      {/* Ambient gradient */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 top-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:14px_24px] opacity-10" />
      <div className="pointer-events-none absolute left-0 right-0 top-[-10%] h-[1000px] w-[1000px] rounded-full bg-[radial-gradient(circle_400px_at_50%_300px,#fbfbfb36,#000)] opacity-10" />

      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-8 md:px-8">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Cardinality Snapshot
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Prometheus metric cost navigator
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Analyze active series in one snapshot, spot high-cardinality
              metrics, and export production-ready drop rules.
            </p>
          </div>
          {snapshot ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 shrink-0"
              onClick={() => setActivitySheetOpen(true)}
            >
              <Terminal className="size-3.5" />
              Activity log
            </Button>
          ) : null}
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
              savings={savings}
            />

            {/* Two-pane layout */}
            <div className={cn("grid gap-6", activePanel ? "xl:grid-cols-[2fr_3fr]" : "xl:grid-cols-[3fr_2fr]")}>

              {/* LEFT PANE */}
              <div className="flex flex-col gap-6">
                <JobsTable
                  snapshot={snapshot}
                  selectedJob={selectedJob}
                  activePanel={activePanel}
                  filterByJob={filterByJob}
                  onJobClick={(job) => { void loadJobDrilldown(job) }}
                  onClearFilter={() => {
                    setFilterByJob(null)
                    setActivePanel(null)
                  }}
                />
                <MetricsTable
                  snapshot={snapshot}
                  visibleMetrics={visibleMetrics}
                  dropMetrics={dropMetrics}
                  savings={savings}
                  selectedMetric={selectedMetric}
                  activePanel={activePanel}
                  filterByJob={filterByJob}
                  onMetricClick={(metric) => { void loadMetricDrilldown(metric) }}
                  onToggleDrop={toggleDropMetric}
                  onDropTop5={dropTop5}
                  onClearAllDrop={clearAllDropMetrics}
                />
              </div>

              {/* RIGHT PANE */}
              <div className="flex flex-col gap-4">

                {/* Collapsed job strip */}
                {activePanel === "metric" &&
                  jobDrilldownCollapsed &&
                  selectedJob &&
                  jobDrilldown ? (
                  <div
                    className="flex cursor-pointer items-center gap-3 rounded-2xl border bg-card/60 px-4 py-3 hover:bg-card"
                    onClick={() => {
                      setActivePanel("job")
                      setJobDrilldownCollapsed(false)
                    }}
                  >
                    <Database className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm font-medium">
                      Job: {selectedJob}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {jobDrilldown.metrics.length} metrics
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                ) : null}

                {activePanel === null ? (
                  <RightPaneEmpty
                    chartRows={chartRows}
                    snapshot={snapshot}
                    onMetricClick={(metric) => { void loadMetricDrilldown(metric) }}
                    onJobClick={(job) => { void loadJobDrilldown(job) }}
                  />
                ) : null}

                {activePanel === "job" ? (
                  <JobDrilldownPanel
                    selectedJob={selectedJob}
                    jobDrilldown={jobDrilldown}
                    isLoadingJob={isLoadingJob}
                    dropMetrics={dropMetrics}
                    onMetricClick={(metric) => {
                      void loadMetricDrilldown(metric, true)
                    }}
                    onToggleDrop={toggleDropMetric}
                    onClose={() => {
                      setActivePanel(null)
                      setFilterByJob(null)
                    }}
                  />
                ) : null}

                {activePanel === "metric" ? (
                  <MetricDrilldownPanel
                    selectedMetric={selectedMetric}
                    metricDrilldown={metricDrilldown}
                    isLoadingMetric={isLoadingMetric}
                    dropMetrics={dropMetrics}
                    jobDrilldownCollapsed={jobDrilldownCollapsed}
                    connection={connection}
                    onToggleDrop={toggleDropMetric}
                    onClose={() => {
                      if (jobDrilldownCollapsed) {
                        setActivePanel("job")
                        setJobDrilldownCollapsed(false)
                      } else {
                        setActivePanel(null)
                      }
                    }}
                  />
                ) : null}
              </div>
            </div>
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
      {dropMetrics.length > 0 ? (
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
              {dropMetrics.length}
            </Badge>
          </Button>
        </div>
      ) : null}

      {/* ── Drop rules dialog ──────────────────────────────────────────── */}
      <DropRulesDialog
        open={dropRulesOpen}
        onOpenChange={setDropRulesOpen}
        dropMetrics={dropMetrics}
        snapshot={snapshot}
        savings={savings}
        generatedConfigs={generatedConfigs}
        copiedYaml={copiedYaml}
        copiedHcl={copiedHcl}
        onRemoveMetric={toggleDropMetric}
        onClearAll={clearAllDropMetrics}
        onCopyYaml={() => copyToClipboard(generatedConfigs.prometheusYaml, "yaml")}
        onCopyHcl={() => copyToClipboard(generatedConfigs.alloyHcl, "hcl")}
      />
    </main>
  )
}
