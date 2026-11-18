import * as React from "react"
import { ArrowSquareOutIcon, GlobeIcon, HardDrivesIcon, PlugsConnectedIcon, SlidersHorizontalIcon, TerminalWindowIcon } from "@phosphor-icons/react"

import { CodeBlock } from "@/components/code-block"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Page, PageHeader } from "@/components/page"
import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ContinueLocallyButton } from "@/features/settings/local-handoff"
import { ProxyServerField } from "@/features/settings/proxy-server-field"
import { INSTALL_SCRIPT, LOCAL_APP_URL, LOCAL_HTTPS_URL, RELEASES_URL, SERVER_OPTIONS, startCommand, type InstallMethod } from "@/lib/core/own-server"
import { useAppStore } from "@/lib/store/app-store"
import { useServerStore } from "@/lib/store/server-store"

// Running Cardinal yourself: start it with one command, then open it, or keep
// using this page with it as the proxy. The hosted app has no proxy of its
// own, so this is how backends without CORS (Grafana Cloud too) are reached.

const METHODS = [
  { value: "npx", label: "npx" },
  { value: "binary", label: "Binary" },
  { value: "docker", label: "Docker" },
] as const

const METHOD_NOTE: Record<InstallMethod, string> = {
  npx: "Needs Node 20 or later.",
  binary: "A single file for Linux, macOS or Windows. The script checks it against the release's SHA256SUMS.",
  docker: "Published on 127.0.0.1 only, so other machines can't use it.",
}

export function OwnServerPage() {
  const server = useServerStore((state) => state.server)
  const signal = useAppStore((state) => state.signal)
  const [method, setMethod] = React.useState<InstallMethod>("npx")
  // The page that would use the server as its proxy; a page the server serves needs no flag.
  const origin = server ? undefined : globalThis.location?.origin

  return (
    <Page className="max-w-4xl">
      <PageHeader
        eyebrow={<Badge variant="outline">Self-host</Badge>}
        title="Run Cardinal yourself"
        description="One command runs the app and its proxy on your machine. Credentials and queries go from there to your backends, and backends that block browsers, Grafana Cloud included, just work."
      />

      {server ? (
        <p className="flex items-center gap-2 rounded-2xl border border-brand/25 bg-brand/5 px-4 py-3 text-sm">
          <HardDrivesIcon className="size-4 shrink-0 text-brand-ink" />
          You're on your own Cardinal server ({server.version}): its proxy is this page's. Below is how to run it elsewhere.
        </p>
      ) : null}

      <Frame>
        <FrameHeader
          icon={TerminalWindowIcon}
          title="1 · Start it"
          action={<SegmentedControl aria-label="How to run it" size="sm" value={method} onValueChange={setMethod} options={METHODS} />}
        />
        <FrameWell className="flex flex-col gap-3">
          {method === "binary" ? <CodeBlock code={INSTALL_SCRIPT} /> : null}
          <CodeBlock code={startCommand(method, origin)} />
          <p className="text-xs text-muted-foreground">
            {METHOD_NOTE[method]}{" "}
            {method === "binary" ? (
              <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="text-brand-ink underline-offset-2 hover:underline">
                Or download it
              </a>
            ) : null}
          </p>
          {origin ? (
            <p className="text-xs text-muted-foreground">
              <code className="font-mono text-foreground">--allow-origin {origin}</code> lets this page use it as its proxy. Leave it out
              if you'll only use the app it serves.
            </p>
          ) : null}
        </FrameWell>
      </Frame>

      <div className={server ? "grid gap-4" : "grid gap-4 md:grid-cols-2"}>
        {server ? null : (
          <Frame>
            <FrameHeader icon={GlobeIcon} title="2 · Open it" meta="the whole app, locally" />
            <FrameWell className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                It serves Cardinal at {LOCAL_APP_URL.replace(/^http:\/\//, "")}. Continue there with your work: URLs, rules and prices come
                along, tokens don't.
              </p>
              <div className="flex flex-wrap gap-2">
                <ContinueLocallyButton signal={signal} />
                <Button asChild size="sm" variant="ghost">
                  <a href={LOCAL_APP_URL} target="_blank" rel="noreferrer">
                    Open it empty
                    <ArrowSquareOutIcon data-icon="inline-end" />
                  </a>
                </Button>
              </div>
            </FrameWell>
          </Frame>
        )}
        {server ? null : (
          <Frame>
            <FrameHeader icon={PlugsConnectedIcon} title="Or keep this page" meta="your server as its proxy" />
            <FrameWell className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                This page sends each request to your server, which forwards it to the backend. Started with the flag above, it answers here.
                Chrome, Edge and Firefox ask once to let this site reach apps on your device: allow it.
              </p>
              <p className="text-sm text-muted-foreground">
                Safari blocks https pages from calling http://localhost. Add{" "}
                <code className="font-mono text-foreground">--tls-cert &lt;file&gt; --tls-key &lt;file&gt;</code> with a certificate your Mac
                trusts, then use <code className="font-mono text-foreground">{LOCAL_HTTPS_URL}</code>.
              </p>
              <ProxyServerField id="own-server-address" />
            </FrameWell>
          </Frame>
        )}
      </div>

      <Frame>
        <FrameHeader icon={SlidersHorizontalIcon} title="Options" meta="cardinal --help lists them all" />
        <FrameWell>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            {SERVER_OPTIONS.map((option) => (
              <div key={option.flag} className="contents">
                <dt>
                  <code className="font-mono text-xs text-foreground">{option.flag}</code>
                </dt>
                <dd className="-mt-2 text-muted-foreground sm:mt-0">{option.what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Most have an environment variable too, like <code className="font-mono text-foreground">CARDINAL_DEBUG=1</code>, handy in Docker.
          </p>
        </FrameWell>
      </Frame>

      <Frame>
        <FrameHeader title="Good to know" />
        <FrameWell>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
            <li>It listens on 127.0.0.1. With --allow-origin, only that site may use its proxy, and only while it runs.</li>
            <li>
              A backend with a self-signed certificate? Turn on Skip certificate check for that connection, under Advanced. Only it skips
              the check; Grafana Cloud and the rest stay checked.
            </li>
            <li>
              Something not working? It says in its terminal when it turns a site away, and which flag would let it in.{" "}
              <code className="font-mono text-foreground">--debug</code> shows every request.
            </li>
            <li>
              To share one with your team, run the Docker image on a server behind your own auth and name its host with --public-hosts: anyone
              who can open it can use its proxy.
            </li>
            <li>Agent sessions run on the hosted app; with your server as its proxy, the agent's queries go through your server too.</li>
          </ul>
        </FrameWell>
      </Frame>
    </Page>
  )
}
