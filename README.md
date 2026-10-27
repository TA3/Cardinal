<div align="center">
  <img src="public/favicon.svg" width="72" alt="Cardinal logo" />
  <h1>Cardinal</h1>
  <p><strong>Find and cut cardinality in Prometheus and Loki.</strong></p>
  <p>
    <a href="https://cardinal.ta3.dev">Open the app</a> ·
    <a href="#privacy">Privacy</a> ·
    <a href="#run-it-on-your-machine">Run it on your machine</a> ·
    <a href="#self-host">Self-host</a> ·
    <a href="#develop">Develop</a> ·
    <a href="#connect-an-agent">Connect an agent</a>
  </p>
</div>

<br />

![Cardinal overview](public/screenshot.png)

Cardinal shows which jobs, metrics and labels make up your active series, and which services and labels create your log
streams and volume. Pick what to drop, check nothing depends on it, and export the rules.

## Features

- **Metrics:** series by job, metric and label, churn, and histogram bucket analysis
- **Logs:** Loki streams, labels, ingest volume and repeated line patterns
- **Safe drops:** checks alert rules and Grafana dashboards before you drop anything
- **Rules:** export Prometheus relabel configs, Grafana Alloy, Promtail and Loki limits, or apply Grafana Cloud Adaptive Metrics and Adaptive Logs
- **Grafana:** connect through your Grafana data sources, and export a dashboard that links back to Cardinal
- **Attribution:** split series, volume and cost by team, namespace or any label
- **Agents:** an MCP endpoint lets Claude or any MCP client analyse your data and propose rules for you to review

## Privacy

Pick how much you share; each option works on its own.

| Option | You give Cardinal | Cardinal's servers see |
| --- | --- | --- |
| **No credentials** | One query result you paste, and dashboard or rule files you upload | Nothing |
| **[Run it on your machine](#run-it-on-your-machine)** | Credentials, kept on your machine | Nothing |
| **Direct** | Credentials, kept in your browser | Nothing: the browser calls your backend, which must allow CORS |
| **Cardinal's proxy** | Credentials, kept in your browser | Each request and its token in transit, never stored or logged |

Grafana Cloud doesn't allow browser requests, so from cardinal.ta3.dev it needs the proxy. Cardinal asks before
using it; you can turn it off in **Settings → Privacy**.

**No credentials.** Run `count by (job, __name__) ({__name__=~".+"})` as an instant query wherever you already
have access (Grafana Explore, `curl`, `promtool`) and paste the result under **Settings → Metrics → Paste a result**.
For dashboard usage, upload dashboard JSON, alert rule exports or Prometheus rule files under **Settings → Grafana**.
For logs, run `sum by (service_name) (bytes_over_time({service_name=~".+"}[24h]))` (and optionally the matching stream
count) and paste it under **Settings → Logs → Paste a result**. Drilldowns, history, labels, patterns and impact checks
need a live connection; volume, savings, rules and exports work.

Agents get metric, job and label names and series counts. Label values are only shared once you turn that on.

## Develop

Cardinal is a Vite app and one Cloudflare Worker.

```bash
bun install
bun dev            # app and worker on one port
bun run test
bun run deploy     # build and deploy to Cloudflare
```

For production, set a secret that signs proxy tokens:

```bash
openssl rand -hex 32 | bunx wrangler secret put PROXY_SECRET
```

Locally, put it in `.dev.vars` together with `PUBLIC_HOSTNAMES=localhost,127.0.0.1`. Set `PUBLIC_HOSTNAMES` and
`routes` in `wrangler.jsonc` to your own domain.

## Run it on your machine

The `cardinal` binary is the whole app plus its proxy. It listens on `127.0.0.1` only, and your browser talks to
it instead of a Cardinal server.

```bash
curl -fsSL https://github.com/TA3/cardinal/releases/latest/download/install.sh | sh
cardinal          # then open http://localhost:9181
```

The script checks the binary against the release's `SHA256SUMS`. You can also download it from the
[releases page](https://github.com/TA3/cardinal/releases) yourself (Linux, macOS, Windows), or use Docker below.

## Self-host

The container serves the app and a proxy that, unlike the hosted one, reaches private and loopback hosts, so
Prometheus, Loki and Grafana on your network work without CORS.

```bash
docker run -p 9181:9181 ghcr.io/ta3/cardinal
```

Limit what it may reach with `--allow-hosts`. Only the app it serves can use its proxy, but anyone who can open
that app can, so keep it on a trusted network or behind auth. Agent sessions need the hosted app.

## Connect an agent

Open **Agent → Start agent session**, then add the endpoint to your MCP client:

```bash
claude mcp add --transport http cardinal https://cardinal.ta3.dev/mcp \
  --header "Authorization: Bearer <token>"
```

The agent can read your snapshot, measure the impact of a change and propose rules. Nothing changes until you accept
it, and the tab has to stay open while the agent works.

## Rule formats

| Signal  | Export                                                                      | Apply                         |
| ------- | --------------------------------------------------------------------------- | ----------------------------- |
| Metrics | `metric_relabel_configs`, `write_relabel_configs`, Alloy `prometheus.relabel` | Grafana Cloud Adaptive Metrics |
| Logs    | Alloy `loki.process`, Promtail `pipeline_stages`, Loki `retention_stream`   | Grafana Cloud Adaptive Logs    |

Label drops that would merge Prometheus series are only exported as Adaptive Metrics aggregations, since relabelling them
creates duplicate samples.

<details>
<summary><strong>How it works</strong></summary>

<br />

- The React app is served as static assets from the Worker.
- `/api/proxy/*` forwards read-only API calls to backends without CORS. It refuses private hosts, only allows known
  paths, is rate limited, and needs a short-lived token from `/api/proxy-token`.
- `/mcp` and `/api/sessions` run agent sessions. Each session is a Durable Object holding a WebSocket to your tab, which
  runs every query with its own connection, so the Worker and the agent never see your credentials.

```
app/          router and app shell
features/     one folder per page
components/   shared UI (shadcn in components/ui)
hooks/        data hooks, agent bridge, impact measurement
lib/core/     pure logic: PromQL, LogQL, rules, compilers, parsers
lib/sources/  Prometheus, Loki, Grafana and Adaptive Telemetry clients
lib/agent/    MCP tools and the tab-side executor
worker/       worker entry, proxy, sessions, MCP server
server/       self-hosted server and binaries (Bun), shares lib/proxy with the worker
```

</details>

---

<p align="center">
  Also check out <a href="https://use.observer">Observer</a>, status pages from the same metrics.
</p>
