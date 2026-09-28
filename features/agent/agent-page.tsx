import * as React from "react"
import {
  ArrowRightIcon,
  CaretDownIcon,
  EyeIcon,
  EyeSlashIcon,
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  RobotIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react"
import { Link } from "react-router"
import { toast } from "sonner"

import { paths, rulesPath } from "@/app/paths"
import { CodeBlock } from "@/components/code-block"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell } from "@/components/frame"
import { Expand, LiveDot } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { SegmentedControl } from "@/components/segmented-control"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useConnection, useRuleCounts } from "@/hooks/use-cardinality"
import { endAgentSession, startAgentSession, takeOverAgentSession } from "@/hooks/use-agent-bridge"
import { toolDefinitions, toolNames } from "@/lib/agent/tools"
import { useAppStore, type AgentActivity, type AgentLinkStatus } from "@/lib/store/app-store"
import { useRelayStore } from "@/lib/store/relay-store"
import { cn } from "@/lib/utils"

const STATUS: Record<AgentLinkStatus, { label: string; tone: "live" | "idle" | "down" }> = {
  idle: { label: "Not started", tone: "idle" },
  connecting: { label: "Connecting", tone: "idle" },
  connected: { label: "Ready for agent", tone: "live" },
  disconnected: { label: "Reconnecting", tone: "down" },
  expired: { label: "Session ended", tone: "down" },
  elsewhere: { label: "Open in another tab", tone: "idle" },
}

function StatusDot({ status }: { status: AgentLinkStatus }) {
  const tone = STATUS[status].tone
  return <LiveDot pulse={tone === "live"} className={tone === "live" ? "text-brand" : tone === "down" ? "text-destructive" : "text-muted-foreground"} />
}

function StartCard() {
  const connection = useConnection()
  const [pending, setPending] = React.useState(false)
  const facts = [
    { icon: LockKeyIcon, title: "Credentials stay here", text: "The agent's queries run in this tab. The agent and the Worker never see your token." },
    { icon: ShieldCheckIcon, title: "Proposals only", text: "The agent can suggest rules. Nothing changes until you accept it in Rules." },
    { icon: PauseIcon, title: "You stay in control", text: "Pause the agent or stop sharing label values at any time; every call is logged here." },
    { icon: TerminalWindowIcon, title: "Short-lived", text: "Ends when you end it, after 1 hour idle, or after 8 hours." },
  ]

  async function start() {
    setPending(true)
    try {
      await startAgentSession()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <EmptyState
        framed
        icon={RobotIcon}
        title="Let an agent find what to cut"
        description="Start a session for a private MCP endpoint, then add it to Claude Code or any MCP client."
      >
        {connection ? (
          <Button onClick={() => void start()} disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : <RobotIcon data-icon="inline-start" />}
            Start agent session
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link to={paths.overview}>Connect a data source first</Link>
          </Button>
        )}
      </EmptyState>
      <Frame>
        <FrameHeader icon={ShieldCheckIcon} title="How it works" />
        <FrameWell className="flex flex-col gap-4 py-4">
          {facts.map((fact) => (
            <div key={fact.title} className="flex items-start gap-3 text-sm">
              <fact.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{fact.title}</span>
                <span className="text-muted-foreground">{fact.text}</span>
              </div>
            </div>
          ))}
        </FrameWell>
      </Frame>
    </div>
  )
}

type ClientTab = "claude-code" | "claude-desktop" | "cursor" | "other"

function clientSnippets(mcpUrl: string, token: string): Record<ClientTab, string> {
  const bearer = `Bearer ${token}`
  return {
    "claude-code": `claude mcp add --transport http cardinal ${mcpUrl} --header "Authorization: ${bearer}"`,
    // mcp-remote bridges stdio-only clients to HTTP. The header goes through an
    // env var because spaces inside args break on some platforms.
    "claude-desktop": JSON.stringify(
      {
        mcpServers: {
          cardinal: {
            command: "npx",
            args: ["-y", "mcp-remote", mcpUrl, "--header", "Authorization:${CARDINAL_AUTH}"],
            env: { CARDINAL_AUTH: bearer },
          },
        },
      },
      null,
      2
    ),
    cursor: JSON.stringify({ mcpServers: { cardinal: { url: mcpUrl, headers: { Authorization: bearer } } } }, null, 2),
    other: [`Transport: Streamable HTTP`, `URL: ${mcpUrl}`, `Header: Authorization: ${bearer}`].join("\n"),
  }
}

const CLIENT_HINTS: Record<ClientTab, string> = {
  "claude-code": "Then ask it to run the cardinality_review prompt, or “what's driving my series count?”",
  "claude-desktop": "Add to claude_desktop_config.json (Settings → Developer → Edit config), then restart Claude Desktop. Needs Node.js for npx.",
  cursor: "Add to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.",
  other: "Any MCP client that supports Streamable HTTP and custom headers.",
}

function SessionCard() {
  const session = useAppStore((state) => state.agentSession)!
  const status = useAppStore((state) => state.agentStatus)
  const paused = useAppStore((state) => state.agentPaused)
  const [reveal, setReveal] = React.useState(false)
  const [tab, setTab] = React.useState<ClientTab>("claude-code")
  const token = session.agentToken
  const masked = `${token.slice(0, 12)}${"•".repeat(20)}`
  const hide = (text: string) => (reveal ? text : text.replaceAll(token, masked))
  const snippets = clientSnippets(session.mcpUrl, token)
  const urlToken = `${session.mcpUrl}/${token}`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <StatusDot status={status} />
          {STATUS[status].label}
          {paused && status === "connected" ? (
            <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
              Paused
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>Expires {new Date(session.expiresAt).toLocaleString()}. Keep this tab open while the agent works.</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setReveal((value) => !value)}>
            {reveal ? <EyeSlashIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
            {reveal ? "Hide token" : "Show token"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void endAgentSession()}>
            <PowerIcon data-icon="inline-start" />
            End session
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === "expired" ? (
          <Alert variant="destructive">
            <AlertTitle>This session has ended</AlertTitle>
            <AlertDescription>It was ended, expired, or sat idle for an hour. End it here and start a new one.</AlertDescription>
          </Alert>
        ) : status === "disconnected" ? (
          <Alert>
            <Spinner />
            <AlertTitle>Reconnecting to the session</AlertTitle>
            <AlertDescription>
              This tab lost its link to the session and keeps retrying on its own, also when the network returns or you come back to
              the tab. The agent's calls fail until it's back.
            </AlertDescription>
          </Alert>
        ) : status === "elsewhere" ? (
          <Alert>
            <AlertTitle>Another tab is serving this session</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              The agent's requests run in that tab, with its pause and sharing settings. Take over to run them here instead.
              <Button size="sm" variant="outline" onClick={() => takeOverAgentSession()}>
                Take over
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-2">
          <SegmentedControl
            size="sm"
            aria-label="MCP client"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "claude-code", label: "Claude Code" },
              { value: "claude-desktop", label: "Claude Desktop" },
              { value: "cursor", label: "Cursor" },
              { value: "other", label: "Other clients" },
            ]}
            className="self-start"
          />
          <CodeBlock code={snippets[tab]} display={hide(snippets[tab])} />
          <p className="text-xs text-muted-foreground">{CLIENT_HINTS[tab]}</p>
          {tab === "other" ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Only if your client can't send headers: put the token in the URL instead. It may then show up in the client's logs.
              </p>
              <CodeBlock code={urlToken} display={hide(urlToken)} />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

/** Tools the agent can call, what each may do, and the user's switches over them. */
function AccessCard() {
  const status = useAppStore((state) => state.agentStatus)
  const paused = useAppStore((state) => state.agentPaused)
  const setPaused = useAppStore((state) => state.setAgentPaused)
  const shareValues = useAppStore((state) => state.agentShareLabelValues)
  const setShareValues = useAppStore((state) => state.setAgentShareLabelValues)
  const elsewhere = status === "elsewhere"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
          Agent access
        </CardTitle>
        <CardDescription>
          {paused ? "Paused: every tool call is refused until you resume. The session stays open." : "What the agent can do through this tab."}
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={paused ? "default" : "outline"}
            disabled={elsewhere}
            title={elsewhere ? "Take over the session to control it from this tab" : undefined}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="agent-share-values">Share label values</FieldLabel>
            <FieldDescription>Off: get_label_values is refused. The agent still sees label names and value counts.</FieldDescription>
          </FieldContent>
          <Switch id="agent-share-values" checked={shareValues} onCheckedChange={setShareValues} />
        </Field>
        <ul className="flex flex-col divide-y divide-border/60 text-sm">
          {toolNames.map((name) => {
            const tool = toolDefinitions[name]
            const blocked = paused || (name === "get_label_values" && !shareValues)
            return (
              <li key={name} className={cn("flex min-w-0 items-center gap-3 py-1.5", blocked && "text-muted-foreground")}>
                <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", blocked && "line-through decoration-muted-foreground/60")} title={tool.description}>
                  {name}
                </span>
                {name === "propose_rules" ? <span className="hidden text-xs text-muted-foreground sm:inline">proposals only</span> : null}
                <Badge
                  variant="outline"
                  className={cn("w-12 shrink-0 justify-center", !tool.readOnly && "border-brand/40 text-brand-ink")}
                >
                  {tool.readOnly ? "read" : "write"}
                </Badge>
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          The only write is propose_rules, which adds pending proposals to Rules. Nothing reaches any backend until you accept and apply it.
        </p>
      </CardContent>
    </Card>
  )
}

function formatArgs(args: unknown) {
  if (args === undefined || args === null) return null
  const text = JSON.stringify(args, null, 2)
  return text === "{}" ? null : text
}

function ActivityRow({ item }: { item: AgentActivity }) {
  const [open, setOpen] = React.useState(false)
  const args = formatArgs(item.args)
  const expandable = Boolean(args || item.durationMs !== undefined || (!item.ok && item.detail))
  return (
    <li className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex min-w-0 items-baseline gap-3 rounded-lg px-2 py-1 text-left text-xs outline-none transition-colors enabled:hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="shrink-0 tabular-nums text-muted-foreground">{new Date(item.at).toLocaleTimeString()}</span>
        <Badge variant={item.ok ? "secondary" : "destructive"} className="shrink-0 font-mono">
          {item.tool}
        </Badge>
        {item.detail ? <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{item.detail}</span> : <span className="flex-1" />}
        {item.durationMs !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatDuration(item.durationMs)}</span> : null}
        {expandable ? (
          <CaretDownIcon className={cn("size-3 shrink-0 self-center text-muted-foreground transition-transform", open && "rotate-180")} />
        ) : null}
      </button>
      <Expand open={open}>
        <div className="flex flex-col gap-2 pt-1 pb-2 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>Result</dt>
            <dd className={item.ok ? "text-foreground" : "text-destructive"}>{item.ok ? "OK" : "Failed"}</dd>
            {item.durationMs !== undefined ? (
              <>
                <dt>Duration</dt>
                <dd className="tabular-nums text-foreground">{item.durationMs.toLocaleString()} ms</dd>
              </>
            ) : null}
            {!item.ok && item.detail ? (
              <>
                <dt>Error</dt>
                <dd className="break-words text-foreground">{item.detail}</dd>
              </>
            ) : null}
          </dl>
          {args ? <CodeBlock code={args} maxHeight="max-h-48" /> : <span className="text-muted-foreground">No arguments.</span>}
        </div>
      </Expand>
    </li>
  )
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

function ActivityCard() {
  const activity = useAppStore((state) => state.agentActivity)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent activity</CardTitle>
        <CardDescription>Every tool call the agent made in this session. Click one for its arguments and timing.</CardDescription>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <EmptyState compact icon={TerminalWindowIcon} title="Waiting for the first tool call" description="Calls show up here as the agent works." />
        ) : (
          <ol className="flex max-h-[32rem] flex-col gap-0.5 overflow-y-auto">
            {activity.map((item, index) => (
              <ActivityRow key={`${item.at}-${activity.length - index}`} item={item} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

/** A self-hosted server has no Durable Objects to hold agent sessions. */
function SelfHostedAgent() {
  return (
    <EmptyState
      framed
      icon={RobotIcon}
      title="Agent sessions need the hosted app"
      description="This Cardinal server is self-hosted, and agent sessions run on the hosted app. Open cardinal.ta3.dev, run this server as its relay (Settings → Relay) so it still reaches your private backends, and start the agent there."
    >
      <Button asChild>
        <a href="https://cardinal.ta3.dev/agent" target="_blank" rel="noopener">
          Open cardinal.ta3.dev
          <ArrowRightIcon data-icon="inline-end" />
        </a>
      </Button>
    </EmptyState>
  )
}

export function AgentPage() {
  const session = useAppStore((state) => state.agentSession)
  const selfHosted = useRelayStore((state) => state.server !== null)
  const counts = useRuleCounts()
  return (
    <Page>
      <PageHeader
        title="Agent"
        description="Connect an AI agent over MCP. It explores your cardinality through this tab and proposes rules for you to review."
        actions={
          counts.proposed ? (
            <Button asChild>
              <Link to={rulesPath("proposed")}>
                Review {counts.proposed} proposal{counts.proposed === 1 ? "" : "s"}
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          ) : null
        }
      />
      {session ? (
        <div className="grid items-start gap-4 xl:grid-cols-[3fr_2fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <SessionCard />
            <AccessCard />
          </div>
          <ActivityCard />
        </div>
      ) : selfHosted ? (
        <SelfHostedAgent />
      ) : (
        <StartCard />
      )}
    </Page>
  )
}
