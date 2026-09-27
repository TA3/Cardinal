import { createBrowserRouter } from "react-router"

import { LegacyRedirect } from "@/app/legacy-redirect"
import { NotFound, RouteError } from "@/app/route-error"
import { AppShell } from "@/app/shell/app-shell"

// Pages load on demand so heavy dependencies (the chart, histogram and churn views) stay out
// of the initial bundle.
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    // Lazy pages resolve before first paint; nothing to show meanwhile.
    HydrateFallback: () => null,
    // The shell itself failed.
    errorElement: <RouteError fullPage />,
    children: [
      {
        // A page failed (including a stale lazy chunk): keep the shell around the error.
        errorElement: <RouteError />,
        children: [
          // "/" and pre-restructure URLs (/jobs/…, /churn, /adaptive, /metrics/<metric>…) redirect.
          { index: true, element: <LegacyRedirect /> },

          // Metrics
          { path: "metrics", lazy: () => import("@/features/overview/overview-page").then((m) => ({ Component: m.OverviewPage })) },
          { path: "metrics/explore", lazy: () => import("@/features/explore/metrics-page").then((m) => ({ Component: m.MetricsPage })) },
          {
            // Metric names never contain "/", so one segment is enough.
            path: "metrics/explore/:metric",
            lazy: () => import("@/features/explore/metric-detail-page").then((m) => ({ Component: m.MetricDetailPage })),
          },
          { path: "metrics/jobs", lazy: () => import("@/features/explore/jobs-page").then((m) => ({ Component: m.JobsPage })) },
          {
            // Job names can contain "/": the whole rest of the path is the job (see jobPath).
            path: "metrics/jobs/*",
            lazy: () => import("@/features/explore/job-detail-page").then((m) => ({ Component: m.JobDetailPage })),
          },
          { path: "metrics/churn", lazy: () => import("@/features/churn/churn-page").then((m) => ({ Component: m.ChurnPage })) },
          { path: "metrics/histograms", lazy: () => import("@/features/histograms/histograms-page").then((m) => ({ Component: m.HistogramsPage })) },
          // Static routes above win, so this only catches old /metrics/<metric> links.
          { path: "metrics/:metric", element: <LegacyRedirect /> },

          // Logs
          { path: "logs", lazy: () => import("@/features/logs/logs-overview-page").then((m) => ({ Component: m.LogsOverviewPage })) },
          { path: "logs/streams", lazy: () => import("@/features/logs/streams-page").then((m) => ({ Component: m.StreamsPage })) },
          // Group values may contain "/": logGroupPath encodes them into one segment.
          { path: "logs/streams/:group", lazy: () => import("@/features/logs/stream-detail-page").then((m) => ({ Component: m.StreamDetailPage })) },
          { path: "logs/labels", lazy: () => import("@/features/logs/labels-page").then((m) => ({ Component: m.LabelsPage })) },
          { path: "logs/volume", lazy: () => import("@/features/logs/volume-page").then((m) => ({ Component: m.LogVolumePage })) },
          { path: "logs/patterns", lazy: () => import("@/features/logs/patterns-page").then((m) => ({ Component: m.LogPatternsPage })) },

          // Shared
          { path: "rules", lazy: () => import("@/features/rules/rules-page").then((m) => ({ Component: m.RulesPage })) },
          { path: "attribution", lazy: () => import("@/features/attribution/attribution-page").then((m) => ({ Component: m.AttributionPage })) },
          { path: "agent", lazy: () => import("@/features/agent/agent-page").then((m) => ({ Component: m.AgentPage })) },
          { path: "settings", lazy: () => import("@/features/settings/settings-page").then((m) => ({ Component: m.SettingsPage })) },

          // Old URLs
          { path: "jobs", element: <LegacyRedirect /> },
          { path: "jobs/*", element: <LegacyRedirect /> },
          { path: "churn", element: <LegacyRedirect /> },
          { path: "histograms", element: <LegacyRedirect /> },
          { path: "adaptive", element: <LegacyRedirect /> },
          { path: "teams", element: <LegacyRedirect /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
])
