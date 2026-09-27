# Cardinal

Cardinal analyses Prometheus (and Grafana Cloud / Mimir) cardinality: it takes an
active-series snapshot, lets you drill into jobs, metrics and labels, and exports
rules that cut series. Those rules can be Prometheus `metric_relabel_configs`,
Grafana Alloy `prometheus.relabel` blocks, or Grafana Cloud Adaptive Metrics
aggregations.

An AI agent can do the analysis too. A tab can start an **agent session**, which
exposes a private MCP endpoint. The agent explores the data and proposes rules;
the user accepts or rejects each one in the UI.

## Running

```bash
bun install
bun dev          # Vite + the Worker (proxy, sessions, MCP) on one port
bun run test     # unit tests
bun run typecheck
bun run lint
bun run deploy   # vite build && wrangler deploy
```

Run `bun run cf-typegen` after changing `wrangler.jsonc`.

Local settings go in `.dev.vars` (gitignored):

```bash
PUBLIC_HOSTNAMES=localhost,127.0.0.1   # hosts allowed to serve /mcp
PROXY_SECRET=<random hex>              # signs proxy tokens
```

In production, set the secret with `wrangler secret put PROXY_SECRET`. Without it,
each Worker isolate signs with its own random key, so proxy tokens stop working
whenever a request lands on a different isolate.

## Architecture

The whole app is one Cloudflare Worker:

- **SPA** (React, Vite) is served as Workers Static Assets.
- **`/api/proxy/*`** passes credentials through to backends that do not send
  CORS headers (Grafana Cloud included). Nothing is stored. The proxy refuses
  private and loopback hosts, allowlists read-style API paths plus the Adaptive
  Metrics API, and is rate limited per IP. Callers must be same-origin and send
  a short-lived token from `/api/proxy-token`, signed with `PROXY_SECRET` and
  bound to the client IP. This stops casual reuse of the proxy as an open relay;
  a determined non-browser client can still fetch a token, so treat it as a
  speed bump rather than authentication.
- **`/api/sessions`** and **`/mcp`** implement agent sessions. Each session is
  one `CardinalSession` Durable Object. It holds a WebSocket to the tab that
  created it and relays MCP tool calls to that tab. The tab runs every query
  with its own connection, so the Worker and the agent never see backend
  credentials. The tab proves ownership with a browser key sent as the first
  WebSocket message, never in a URL. Session creation is rate limited
  (`SESSION_LIMITER`). Sessions end when revoked, after 1 hour idle, or after
  8 hours. Only one tab owns a session at a time; another tab can take it over.

```
app/            router and the app shell (header, tab bar, ⌘K search)
features/       one folder per area: overview, explore, logs, rules, adaptive, agent, settings
components/     shared UI (components/ui is shadcn, preset b57bWM: nova, Phosphor icons)
hooks/          data hooks (TanStack Query), agent bridge, impact measurement
lib/core/       pure logic: safe PromQL, rule model, compilers, parsers, snapshot aggregation
lib/sources/    transport (direct | proxy), Prometheus queries, Adaptive Metrics API
lib/agent/      MCP tool definitions (shared by Worker and tab), relay protocol, tab-side executor
lib/store/      zustand store: connection, snapshot, rules, agent session
worker/         Worker entry, proxy, session Durable Object, MCP server
```

### Navigation

The header has a **Metrics | Logs** signal switch. Each signal owns a route prefix and its
own tabs; the shared tabs after the divider follow whichever signal you last used:

- Metrics: `/metrics` (overview), `/metrics/explore[/:metric]`, `/metrics/jobs[/*]`,
  `/metrics/churn`, `/metrics/histograms`
- Logs (Loki, coming): `/logs`, `/logs/streams`, `/logs/labels`, `/logs/volume`, `/logs/patterns`
- Shared: `/rules` (with `?view=recommendations` for Adaptive Metrics / Adaptive Logs),
  `/attribution`, `/agent`, `/settings`

Switching signal returns to that signal's last page. `g` chords follow the signal (`g o` is its
overview, `g m` / `g l` switch). Old URLs (`/jobs/…`, `/churn`, `/histograms`, `/adaptive`,
`/teams`, `/metrics/<metric>`) redirect, keeping the query string. Build links with the helpers
in `app/paths.ts`. Add UI with `bunx --bun shadcn@latest add <component>`.

### Rules

A rule either drops a metric or drops labels from a metric, optionally scoped to
one job. Cardinal measures a label drop's exact impact with
`count(count without (labels) (metric))`.

Some label drops merge distinct series. Those rules are never emitted as relabel
config, because relabelling them produces duplicate samples. They are only
exported as Adaptive Metrics aggregations, which merge the series safely.

### Histograms

**Metrics → Histograms** (`/metrics/histograms`) lists classic histogram families by
bucket series, with `le` count, label sets and two estimates: keeping about six
buckets (a `keep_buckets` relabel rule, proposed for review) and migrating to
native histograms. Each family's reduced `le` set is weighted by
`sum by (le) (rate(x_bucket[1h]))` and keeps the buckets around quantiles that
alerting and recording rules query; the precision table shows how far each
quantile's error band widens. Native histograms already in use are detected
with `histogram_count`. The agent tool is `get_histograms`.

### Attribution

**Attribution** (`/attribution`) is optional: turn it on in **Settings →
Attribution** and pick up to three labels (Primary, Secondary, Third, e.g.
`team` → `namespace` → `service`). Each series belongs to its Primary label's
value; without it, the Secondary, then the Third. One
`count by (L1, L2, L3) ({__name__=~".+"})` resolves the chain client-side (per
job on tenants too large for one query). Series with none of the labels fall
through to **custom rules**, CODEOWNERS for metrics: owners with ordered `job`,
metric-prefix or `label <name>` regexes, first match wins, run on
`count by (job, __name__) ({L1="", L2="", L3=""})`; the rest is Unattributed.
The page shows each owner's series, share, cost, "via" label and rule savings
(exact for rule owners; estimates from the owner's top metrics for label
owners), a lazy per-owner drilldown by the next label down, and Markdown reports.
Custom rules import and export as JSON or text. The agent tool is
`get_attribution` (`get_teams` is a deprecated alias). Teams from earlier
versions migrate to custom rules with attribution turned on.

### Dashboard usage

**Settings → Grafana** scans any Grafana (self-hosted or Cloud) with
a Viewer service account token: every dashboard (rows, collapsed rows, library
panels, template variables) and Grafana-managed alert rule, read-only. Each
PromQL query is parsed (`lib/core/promql-refs.ts`) into the metrics it reads and
how it uses their labels: matchers, `by`/`without`, `on`/`ignoring`,
`group_left`/`group_right`, `label_replace`/`label_join`, legend `{{label}}`,
and whether the label still reaches the result. The index is cached per Grafana
URL in IndexedDB. The drop gate, Accept all and the metric page then say which
panels use a metric and, for a label drop, whether any panel filters or groups
by that label. Grafana sends no CORS headers by default, so a public Grafana
needs proxy mode. The agent tool is `check_dashboard_usage`.

### Grafana

Grafana is optional, and each signal can still use its own backend. **Settings → Grafana** holds
the one Grafana URL and token (empty for anonymous Grafanas such as play.grafana.org; Viewer is
enough to read, Editor to create dashboards). **Connect Grafana** (on both Welcome pages, in
Settings and in the ⋮ menu) lists the Prometheus and Loki data sources, lets you pick one per
signal or "Don't use Grafana", remembers the pick, optionally scans dashboards, and connects
through `<grafana>/api/datasources/proxy/uid/<uid>` (`lib/core/grafana-connect.ts`). When a data
source's URL is a Grafana Cloud host, it offers a direct connection with an access policy token,
which Adaptive Metrics and Adaptive Logs need. Connection forms then show "via Grafana" with Change
and Disconnect, and editing the URL by hand drops the link.

**Export Grafana dashboard** (⋮ menu, Settings → Grafana) generates a schema 39 dashboard
(`lib/core/grafana-dashboard.ts`) with `datasource`, `logs`, `cardinal_url` and `job` variables,
Metrics and Logs rows, and data links back to `/metrics/jobs/…`, `/metrics/explore/…` and
`/logs/streams/…?by=`. Download or copy the JSON, or create it with `POST /api/dashboards/db` (the
proxy's only Grafana write). An existing uid is replaced only with Overwrite. A deep link opened
without a connection offers both ways to connect, then continues to the page.

### Logs (Loki)

Logs have their own connection (Settings → Logs (Loki)), separate from metrics.
**Pick from Grafana** lists a Grafana's Loki or Prometheus data sources and
connects through `<grafana>/api/datasources/proxy/uid/<uid>` with the Grafana
token; try `https://play.grafana.org` (anonymous, `grafanacloud-logs`). The logs
snapshot (`lib/core/logs/snapshot.ts`, fetched by `lib/sources/loki.ts`) reads
only Loki's index: `index/stats` for streams, `index/volume` for bytes per
service, and label values per label, over 1h, 24h or 7d. Byte figures are
1024-based and index-based, so treat them as estimates. LogQL is built through
`lib/core/logql.ts`, never from raw user text.

The Logs tabs are **Overview** (`/logs`), **Streams** (per service, drilling
into labels, volume by value, sample lines and patterns), **Labels**,
**Volume** and **Patterns**. The shared pages follow the signal in view:
**Rules**, **Attribution** (log bytes and streams by the same Primary /
Secondary / Third labels via `index/volume` with `targetLabels`; custom `job`
rules match the group label, `label` rules match stream labels) and **Agent**.

**Log rules** (`lib/core/logs/rules.ts`) are kept apart from metric rules, with
the same Active / Proposed / Rejected review, share links (`#logrules=`) and
usage check against Loki's alerting and recording rules:

- `drop_streams`: drop whole streams matching a selector
- `drop_lines`: drop lines matching a regex or levels
- `sample`: keep a share of (matching) lines
- `drop_label`: remove a label, merging streams (safe in Loki)
- `label_to_metadata`: move a high-cardinality label to structured metadata (Loki 3+)
- `retention`: keep matching streams for N days (storage only)

Impacts are measured over the snapshot range with `index/stats`,
`bytes_over_time` (line filters, `detected_level` for levels; over the last
hour, scaled to the range, to spare shared Lokis) and the series API (label
rules), and shown per day. Export as a Grafana Alloy `loki.process`
block, Promtail `pipeline_stages`, Loki `limits_config.retention_stream`, or
Grafana Cloud Adaptive Logs drop rules; import Alloy, Promtail and Loki limits
back. On a Grafana Cloud Loki connection (`https://logs-prod-….grafana.net`,
basic auth with an `adaptive-logs:admin` token) **Apply to Adaptive Logs**
merges Cardinal's drop rules into the remote ones: a per-rule diff first, new
targets created, weaker or disabled ones raised (never loosened), and what it
changed saved in the browser so **Revert last apply** can delete what it
created and restore what it updated, only if nobody edited them since. Rules →
**Recommendations** under Logs lists Adaptive Logs' recommended drop rates per
pattern with the bytes per day they'd save; propose them as sampling rules, or
propose exemptions, which are created on the next apply. A datasource proxy
(Pick from Grafana) can't reach the Adaptive Logs API; use the Patterns page
there.

## Connecting an agent

Open **Agent → Start agent session**, then add the endpoint to your MCP client:

```bash
claude mcp add --transport http cardinal https://<host>/mcp \
  --header "Authorization: Bearer <token>"
```

The tab must stay open while the agent works. Tools:

- `get_overview`
- `list_metrics`
- `get_metric_breakdown`
- `get_label_values`
- `check_usage`
- `estimate_impact`
- `get_adaptive_recommendations`
- `get_rules`
- `propose_rules`
- `render_config`

For logs: `get_logs_overview`, `refresh_logs_snapshot`, `list_log_services`,
`get_log_labels`, `get_log_volume`, `get_log_patterns`, `estimate_log_impact`,
`propose_log_rules`, `get_log_rules`, `render_log_config` and
`get_log_recommendations`. Patterns, sample lines and values of labels other
than the group label respect the "Share label values" switch.

There is also a `cardinality_review` prompt, which covers logs when a logs
connection exists.
