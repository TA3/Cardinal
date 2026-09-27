import type { JobDrilldownResponse, MetricDrilldown } from "@/lib/prometheus/types"

interface ParsedMetricSample {
  name: string
  labels: Record<string, string>
  value: number | string
  timestamp: number | null
}

interface ParsedMetric {
  name: string
  type: string | null
  help: string | null
  sampleCount: number
  labelKeys: string[]
  exampleSeries: ParsedMetricSample[]
  relatedMetrics: string[]
}

interface ParsedMetricsResult {
  totalMetrics: number
  totalSamples: number
  metrics: ParsedMetric[]
}

interface GenerateAIPromptOptions {
  job?: string
  maxExamplesPerMetric?: number
}

export function buildPromptDataForJob(
  jobDrilldown: JobDrilldownResponse,
  metricDrilldowns: Record<string, MetricDrilldown | undefined> = {},
  maxMetrics = 20
): ParsedMetricsResult {
  const metrics: ParsedMetric[] = jobDrilldown.metrics
    .slice(0, Math.max(1, maxMetrics))
    .map((row) => {
      const drilldown = metricDrilldowns[row.metric]
      const labelKeys = (drilldown?.labels ?? []).map((label) => label.label)

      const labelsExample = Object.fromEntries(
        (drilldown?.labels ?? []).slice(0, 5).map((label) => [
          label.label,
          `<${label.cardinality} values>`,
        ])
      )

      return {
        name: row.metric,
        type: null,
        help: null,
        sampleCount: row.seriesCount,
        labelKeys,
        exampleSeries:
          Object.keys(labelsExample).length > 0
            ? [
                {
                  name: row.metric,
                  labels: labelsExample,
                  value: row.seriesCount,
                  timestamp: null,
                },
              ]
            : [],
        relatedMetrics: [],
      }
    })

  return {
    totalMetrics: metrics.length,
    totalSamples: metrics.reduce((sum, metric) => sum + metric.sampleCount, 0),
    metrics,
  }
}

export function generateAIPrompt(
  data: ParsedMetricsResult,
  options: GenerateAIPromptOptions = {}
) {
  const maxExamplesPerMetric = Math.max(0, options.maxExamplesPerMetric ?? 3)
  const metricsText = data.metrics.map((m) => {
    const labels = m.labelKeys.length ? m.labelKeys.join(', ') : 'none';
    const examples = m.exampleSeries.slice(0, maxExamplesPerMetric).map(e => {
      const ls = Object.entries(e.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      return `    - ${e.name}{${ls || ''}} = ${e.value}`;
    }).join('\n');

    return [
      `Metric: ${m.name}`,
      m.type ? `  Type: ${m.type}` : null,
      m.help ? `  Help: ${m.help}` : null,
      `  Labels: ${labels}`,
      `  Sample count: ${m.sampleCount}`,
      m.relatedMetrics.length > 0 ? `  Related metrics: ${m.relatedMetrics.join(', ')}` : null,
      examples ? `  Examples:\n${examples}` : null
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `You are an expert Grafana dashboard designer with deep knowledge of Prometheus metrics and PromQL.

${options.job ? `Focus on job: ${options.job}\n` : ""}

I have extracted metrics from a Prometheus exporter. Your task is to design a comprehensive Grafana dashboard based on these metrics.

Dashboards are JSON documents stored in Grafana. Every dashboard has panels, variables, time
range, and refresh settings. Understanding the JSON schema lets you programmatically create and
modify dashboards via the API or Grafana Assistant tools.

---

## Dashboard JSON structure

\`\`\`json
{
  "title": "My Dashboard",
  "uid": "my-dashboard-v1",
  "tags": ["service", "production"],
  "time": { "from": "now-1h", "to": "now" },
  "refresh": "30s",
  "timezone": "browser",
  "schemaVersion": 41,
  "templating": { "list": [] },
  "annotations": { "list": [] },
  "panels": []
}
\`\`\`

**Key fields:**
- uid - stable identifier used in URLs and API calls; keep it short and meaningful
- schemaVersion - use 41 for Grafana 11+
- time.from / to - supports relative (now-1h, now-7d) and absolute ISO timestamps
- refresh - auto-refresh interval ("30s", "1m", "5m", "" for off)

---

## Panel types and when to use them

| Panel | Use case |
|---|---|
| **Time series** | Any metric over time; the default choice for counters, rates, gauges |
| **Stat** | Single current value with optional sparkline (e.g. uptime, current RPS) |
| **Gauge** | Percent or value against a min/max (e.g. disk usage %) |
| **Bar gauge** | Compare multiple values side by side (e.g. top 10 services by RPS) |
| **Table** | Multi-column data (e.g. alert list with labels) |
| **Heatmap** | Distribution over time (e.g. request duration histogram) |
| **Logs** | Loki log streams |
| **Traces** | Tempo trace search |
| **Text** | Markdown documentation panels |
| **Candlestick** | OHLC/financial data (or min/max/avg patterns) |
| **Node graph** | Service dependency graphs |

---

## Panel JSON structure

\`\`\`json
{
  "id": 1,
  "type": "timeseries",
  "title": "Request Rate",
  "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
  "datasource": { "type": "prometheus", "uid": "\${datasource}" },
  "targets": [
    {
      "expr": "sum(rate(http_requests_total{job=\\"$job\\"}[5m])) by (status_code)",
      "legendFormat": "{{status_code}}",
      "refId": "A"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "reqps",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green", "value": null },
          { "color": "yellow", "value": 1000 },
          { "color": "red", "value": 5000 }
        ]
      }
    },
    "overrides": []
  },
  "options": {
    "legend": { "calcs": ["mean", "max", "last"], "displayMode": "table", "placement": "bottom" },
    "tooltip": { "mode": "multi", "sort": "desc" }
  }
}
\`\`\`

**gridPos:** The dashboard uses a 24-column grid. Common widths: full-width=24, half=12, third=8, quarter=6. Height in grid units (1 unit ≈ 30px).

---

## Useful unit identifiers

\`\`\`
# Rates
"reqps"      -- requests per second
"ops"        -- operations per second
"Bps"        -- bytes per second
"percentunit" -- 0.0-1.0 as percentage

# Storage
"bytes"      -- bytes (auto-scales to KB/MB/GB)
"decbytes"   -- decimal bytes (1 KB = 1000 B)

# Time
"ms"         -- milliseconds
"s"          -- seconds
"dtdurationms" -- duration in ms (shows as "1h 2m 3s")

# Counts
"short"      -- compact number (1.2k, 3.4M)
"none"       -- raw number
\`\`\`

Full list: **Panel > Field > Unit** dropdown in Grafana UI, or the [units reference](https://grafana.com/docs/grafana/latest/panels-visualizations/configure-standard-options/#unit).

---

## Template variables

Variables make dashboards reusable across environments and services.

**Query variable (populates from metric labels):**

\`\`\`json
{
  "name": "job",
  "type": "query",
  "datasource": { "type": "prometheus", "uid": "prometheus" },
  "query": { "query": "label_values(up, job)", "refId": "A" },
  "refresh": 2,
  "includeAll": true,
  "multi": true,
  "label": "Service"
}
\`\`\`

**Constant variable:**

\`\`\`json
{
  "name": "cluster",
  "type": "constant",
  "query": "production",
  "label": "Cluster"
}
\`\`\`

**Datasource variable (switch data sources without editing queries):**

\`\`\`json
{
  "name": "datasource",
  "type": "datasource",
  "pluginId": "prometheus",
  "includeAll": false,
  "label": "Prometheus"
}
\`\`\`

**Use variables in queries:**

\`\`\`promql
# Reference a variable in a PromQL query
rate(http_requests_total{job=~"$job"}[5m])

# Multi-value variable uses regex OR automatically
# When $job = ["api", "worker"], it becomes job=~"api|worker"
\`\`\`

**Chain variables** (second variable filters based on first):

\`\`\`json
{
  "name": "pod",
  "query": "label_values(kube_pod_info{namespace=\\"$namespace\\"}, pod)"
}
\`\`\`

---

## Transformations

Transformations run client-side after data is fetched, reshaping results without changing queries.

**Common transformations:**

\`\`\`json
"transformations": [
  {
    "id": "merge",
    "options": {}
  },
  {
    "id": "organize",
    "options": {
      "renameByName": { "Value #A": "Request Rate", "Value #B": "Error Rate" },
      "excludeByName": { "Time": true }
    }
  },
  {
    "id": "calculateField",
    "options": {
      "alias": "Error %",
      "mode": "reduceRow",
      "reduce": { "reducer": "last" },
      "binary": {
        "left": "errors",
        "right": "total",
        "operator": "/"
      }
    }
  },
  {
    "id": "filterByValue",
    "options": {
      "filters": [{ "fieldName": "Error %", "config": { "id": "greater", "options": { "value": 0.01 } } }],
      "type": "include",
      "match": "any"
    }
  }
]
\`\`\`

**Key transformation IDs:** merge, organize, rename, calculateField, filterByValue,
groupBy, sortBy, limit, labelsToFields, seriesToRows, partitionByValues.

---

## Dashboard linking

**Panel link (click a panel to go somewhere):**

\`\`\`json
"links": [
  {
    "title": "Go to details",
    "url": "/d/details-dashboard?var-service=\${__field.labels.service}",
    "targetBlank": false
  }
]
\`\`\`

**Dashboard link (top-right corner links):**

\`\`\`json
"links": [
  {
    "title": "Runbook",
    "url": "https://wiki.example.com/runbook/\${job}",
    "icon": "external link",
    "targetBlank": true,
    "type": "link"
  }
]
\`\`\`

**Built-in variables for links:**
- '\${__value.raw}' - current data point value
- '\${__field.labels.job}' - label value from current series
- '\${__url.params}' - current URL query parameters (pass-through)
- '\${__from}' / '\${__to}' - current time range as Unix ms

---

## Annotations

Show events overlaid on time series panels (deployments, incidents, etc.).

**Query annotation from Loki:**

\`\`\`json
{
  "datasource": { "type": "loki", "uid": "loki" },
  "expr": "{job=\\"deployments\\"} |= \\"deployed\\"",
  "name": "Deployments",
  "iconColor": "blue",
  "titleFormat": "{{service}} deployed",
  "textFormat": "{{version}} by {{author}}"
}
\`\`\`

**Query annotation from Prometheus:**

\`\`\`json
{
  "datasource": { "type": "prometheus", "uid": "prometheus" },
  "expr": "changes(kube_deployment_status_observed_generation{namespace=\\"production\\"}[5m]) > 0",
  "step": "60s",
  "name": "Deployments",
  "iconColor": "blue",
  "titleFormat": "Deploy: {{deployment}}"
}
\`\`\`

---

## Dashboard via API

\`\`\`bash
# Create or update a dashboard
curl -s -X POST \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  "https://myorg.grafana.net/api/dashboards/db" \
  -d '{
    "dashboard": { <dashboard JSON> },
    "folderUid": "my-folder",
    "overwrite": true,
    "message": "Updated via API"
  }'

# Get a dashboard by UID
curl -s -H "Authorization: Bearer <API_KEY>" \
  "https://myorg.grafana.net/api/dashboards/uid/my-dashboard-v1" | jq '.dashboard'

# Search dashboards
curl -s -H "Authorization: Bearer <API_KEY>" \
  "https://myorg.grafana.net/api/search?query=kubernetes&type=dash-db" | \
  jq '.[] | {uid, title, folderTitle}'

# Create a folder
curl -s -X POST \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  "https://myorg.grafana.net/api/folders" \
  -d '{"uid": "platform-team", "title": "Platform Team"}'
\`\`\`

## Your Tasks:

1. **Analyze the metrics** - Understand what the system/service is and what each metric represents based on naming conventions, types, and descriptions.

2. **Design a dashboard structure** - Propose logical sections (e.g., "Overview", "Latency", "Errors", "Resources", "Throughput"). Make sure everything is organized in a way that tells a story and helps users quickly understand the health and performance of the system.

3. **Create panels** for each section with:
   - Clear, human-readable titles
   - Short descriptions explaining what each panel shows and why it's useful
   - Valid PromQL queries that use:
     - Appropriate functions (rate(), increase(), histogram_quantile(), etc.)
     - Label filters and aggregations (sum by(), avg by(), etc.)
   - Recommended visualization type (time series, stat, gauge, bar, table, heatmap)
   - Suggested variable templates for filtering (e.g., instance, job, namespace)

4. **Reorganise the panels and rows** - make sure the most important metrics are at the top, related metrics are grouped together, and the layout is clean and intuitive.

5. **Suggest alerts** for critical metrics with:
   - Alert name and purpose
   - PromQL expression
   - Suggested thresholds (warning/critical)
   - Brief explanation of why those thresholds make sense

## Output Format:

Provide your response as valid JSON with this structure:

\`\`\`json
{
  "system_summary": "Brief description of what this system/service appears to be",
  "dashboards": [
    {
      "title": "Dashboard Title",
      "description": "Dashboard purpose",
      "variables": [
        {
          "name": "variable_name",
          "label": "Display Label",
          "query": "label_values(metric_name, label_name)",
          "multi": true
        }
      ],
      "rows": [
        {
          "title": "Row/Section Title",
          "panels": [
            {
              "title": "Panel Title",
              "description": "What this panel shows",
              "type": "timeseries | stat | gauge | table | heatmap | bargauge",
              "queries": [
                {
                  "expr": "PromQL expression",
                  "legendFormat": "{{label}}"
                }
              ],
              "thresholds": {
                "warning": 80,
                "critical": 95
              }
            }
          ]
        }
      ],
      "alerts": [
        {
          "name": "Alert Name",
          "description": "What this alert detects",
          "expr": "PromQL expression",
          "for": "5m",
          "severity": "warning | critical",
          "summary": "Alert summary with {{ $labels.instance }}",
          "runbook": "Brief troubleshooting steps"
        }
      ]
    }
  ]
}
\`\`\`

---

## Metrics Summary (${data.totalMetrics} unique metrics, ${data.totalSamples.toLocaleString()} samples):

${metricsText}
`;
}