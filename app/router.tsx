import { createBrowserRouter } from "react-router"

import { legacyLoader, LegacyRedirect } from "@/app/legacy-redirect"
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
          { index: true, loader: legacyLoader, element: <LegacyRedirect /> },

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
          { path: "metrics/:metric", loader: legacyLoader, element: <LegacyRedirect /> },

          // Logs
          { path: "logs", lazy: () => import("@/features/logs/logs-overview-page").then((m) => ({ Component: m.LogsOverviewPage })) },
          { path: "logs/streams", lazy: () => import("@/features/logs/streams-page").then((m) => ({ Component: m.StreamsPage })) },
          // Group values can contain "/": the whole rest of the path is the group (see logGroupPath).
          { path: "logs/streams/*", lazy: () => import("@/features/logs/stream-detail-page").then((m) => ({ Component: m.StreamDetailPage })) },
          { path: "logs/labels", lazy: () => import("@/features/logs/labels-page").then((m) => ({ Component: m.LabelsPage })) },
          { path: "logs/volume", lazy: () => import("@/features/logs/volume-page").then((m) => ({ Component: m.LogVolumePage })) },
          { path: "logs/patterns", lazy: () => import("@/features/logs/patterns-page").then((m) => ({ Component: m.LogPatternsPage })) },

          // Shared
          { path: "plan", lazy: () => import("@/features/plan/plan-page").then((m) => ({ Component: m.PlanPage })) },
          { path: "savings", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "rules", lazy: () => import("@/features/rules/rules-page").then((m) => ({ Component: m.RulesPage })) },
          { path: "attribution", lazy: () => import("@/features/attribution/attribution-page").then((m) => ({ Component: m.AttributionPage })) },
          { path: "agent", lazy: () => import("@/features/agent/agent-page").then((m) => ({ Component: m.AgentPage })) },
          { path: "settings", lazy: () => import("@/features/settings/settings-page").then((m) => ({ Component: m.SettingsPage })) },

          // Old URLs
          { path: "jobs", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "jobs/*", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "churn", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "histograms", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "adaptive", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "teams", loader: legacyLoader, element: <LegacyRedirect /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
])
