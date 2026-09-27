import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toolDefinitions, toolNames } from "@/lib/agent/tools"
import type { CardinalSession } from "./session"

const INSTRUCTIONS = `Cardinal analyses Prometheus metric cardinality and Loki log volume for the user who started this session. Every tool runs inside the user's open Cardinal tab against their backend.

Workflow:
1. get_session_info, then get_overview (refresh_snapshot only if there is no snapshot).
2. Drill into the biggest metrics/jobs with get_metric_breakdown and get_label_values. Look for unbounded labels (ids, urls, timestamps, pod hashes) and unused high-volume metrics.
3. On Grafana Cloud, read get_adaptive_recommendations: they already account for dashboard/query/rule usage.
4. check_usage before proposing to drop anything; estimate_impact for every candidate.
5. propose_rules with a clear summary. Proposals are pending until the user accepts them; you cannot apply anything.

Rules: a drop_labels rule whose estimate reports merges_series=true can only be applied as an Adaptive Metrics aggregation, never as a relabel rule; say so in the rationale. Prefer fewer, high-impact rules. Report savings as series and percent of total.

For Grafana Cloud or Mimir cost questions, also check get_churn: those backends bill on series seen over time, so series that come and go (pods, container ids, request ids) cost money an instant count hides. Pass a metric to find its churn-driving label.

Before any drop_labels proposal, call check_dashboard_usage with the labels: it reads the user's scanned Grafana dashboards and alerts and says per label whether a panel filters, groups or displays by it. Cite that evidence (or that dashboards weren't scanned) in the rationale.

Classic histograms are often the biggest cost: get_histograms suggests reduced le sets (with the quantile precision they cost) and estimates native-histogram savings. Present both as estimates, and say native histograms need client, scrape and query changes.

When the user asks who owns cardinality or which team should cut what, call get_attribution: series, monthly cost, what active rules already save, and top metrics per owner (attributed by the user's labels, then custom rules), plus the Unattributed bucket. If it says attribution is disabled, tell the user they can enable it in Cardinal's Settings. Name the owner in each proposal's rationale.

Logs (Loki): get_session_info's signals.logs says whether a logs connection exists. If it does:
1. get_logs_overview (refresh_logs_snapshot only if there is no logs snapshot), then list_log_services and get_log_volume to find the biggest and fastest-growing services.
2. get_log_labels (per service) for high-cardinality or ID-like labels: they multiply streams; propose label_to_metadata (Loki 3+) or drop_label. get_log_patterns shows noisy line patterns to drop_lines or sample; on Grafana Cloud, get_log_recommendations gives Adaptive Logs drop rates.
3. estimate_log_impact and check_log_usage for every candidate (say so when Loki rules or dashboards read the streams), then propose_log_rules with a clear summary. Report savings as bytes per day and percent of ingest; label rules cut streams, not bytes; retention cuts storage only. Propose a keep rule (with a rationale) for lines that must survive a broader drop.
Log bytes come from Loki's index and are estimates. Patterns and sample lines count as label values: if a tool says sharing is disabled, don't retry it.

The user controls this session from their tab. A tool result starting "Paused by user" means they paused you: stop calling tools, tell the user, and wait for them to resume. If get_label_values reports that the user disabled sharing label values, don't retry it; judge labels from get_metric_breakdown's distinct-value counts.`

type SessionStub = DurableObjectStub<CardinalSession>

export function buildMcpServer(session: SessionStub) {
  const server = new McpServer({ name: "cardinal", version: "0.1.0" }, { instructions: INSTRUCTIONS })

  for (const name of toolNames) {
    const definition = toolDefinitions[name]
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input,
        annotations: { readOnlyHint: definition.readOnly, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await session.callTool(name, args)
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: [{ type: "text" as const, text: message }], isError: true }
        }
      }
    )
  }

  server.registerPrompt(
    "cardinality_review",
    {
      title: "Cardinality review",
      description: "Analyse the connected metrics (and logs, when connected) and propose rules to cut active series and log volume.",
      argsSchema: z.object({
        target_reduction_percent: z.string().optional().describe("Desired reduction in active series, e.g. 20"),
        focus: z.string().optional().describe("Job, team or metric prefix to focus on"),
      }),
    },
    ({ target_reduction_percent, focus }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Review the cardinality of my metrics in Cardinal and propose rules to reduce active series.",
              target_reduction_percent ? `Aim for roughly ${target_reduction_percent}% fewer series.` : "",
              focus ? `Focus on: ${focus}.` : "",
              "Check usage and measure impact before proposing, and explain each rule's trade-off.",
              "If get_session_info shows a logs connection, also review log volume and stream cardinality (biggest services, ID-like labels, noisy patterns) and propose log rules the same way.",
            ]
              .filter(Boolean)
              .join(" "),
          },
        },
      ],
    })
  )

  return server
}
