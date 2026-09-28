import * as React from "react"
import { CheckCircleIcon, NetworkIcon, PulseIcon, WarningCircleIcon } from "@phosphor-icons/react"

import { CodeBlock } from "@/components/code-block"
import { LiveDot } from "@/components/motion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { relayProblem, type ConnectionProblem } from "@/features/settings/connection-check"
import { HOSTED_ORIGIN, type RelayInfo } from "@/lib/sources/proxy-constants"
import { fetchRelayInfo, RelayError } from "@/lib/sources/transport"
import { useRelayStore } from "@/lib/store/relay-store"

const TEST_TIMEOUT_MS = 10_000

/** The command that starts a relay for this page's origin. */
export function relayCommand(origin: string) {
  const extra = origin === HOSTED_ORIGIN ? "" : ` -e CARDINAL_ORIGINS=${origin}`
  return `docker run -p 127.0.0.1:9181:9181${extra} ghcr.io/ta3/cardinal`
}

/** Settings → Relay: the self-hosted `cardinal` server that Relay mode connections go through. */
export function RelaySection() {
  const relay = useRelayStore((state) => state.relay)
  const setRelay = useRelayStore((state) => state.setRelay)
  const server = useRelayStore((state) => state.server)
  const [testing, setTesting] = React.useState(false)
  const [result, setResult] = React.useState<{ info: RelayInfo & { latencyMs: number } } | { problem: ConnectionProblem } | null>(null)
  const origin = globalThis.location?.origin ?? HOSTED_ORIGIN

  const set = (patch: Partial<typeof relay>) => {
    setRelay(patch)
    setResult(null)
  }

  async function test() {
    setTesting(true)
    setResult(null)
    try {
      setResult({ info: await fetchRelayInfo(relay, AbortSignal.timeout(TEST_TIMEOUT_MS)) })
    } catch (error) {
      if (error instanceof RelayError) setResult({ problem: relayProblem(error) })
      else if (error instanceof DOMException && error.name === "TimeoutError") {
        setResult({ problem: { kind: "relay-unreachable", title: "The relay didn't answer", detail: `No answer within ${TEST_TIMEOUT_MS / 1000} s.` } })
      } else setResult({ problem: { kind: "other", title: "Relay test failed", detail: error instanceof Error ? error.message : String(error) } })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card id="relay" className="scroll-mt-32">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NetworkIcon className="size-4 text-muted-foreground" />
          Relay
        </CardTitle>
        <CardDescription>
          {server
            ? "This page is served by a self-hosted Cardinal server, so Proxy already reaches your network. A relay is only needed for backends on another network."
            : "Reach Prometheus, Loki and Grafana on your network: run a Cardinal server there, then choose Relay on a connection. Your backends need no CORS setup."}
        </CardDescription>
        {relay.url.trim() ? (
          <CardAction>
            <Badge variant="outline" className="border-brand/30 text-brand-ink">
              <LiveDot className="size-1.5" pulse={false} />
              Configured
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel>Start a relay</FieldLabel>
            <CodeBlock code={relayCommand(origin)} className="w-full" />
            <FieldDescription>
              Or run the <code className="font-mono text-xs">cardinal</code> binary from GitHub Releases. It prints a relay token at startup; set
              CARDINAL_RELAY_TOKEN to keep the same one across restarts.
            </FieldDescription>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="relay-url">Relay URL</FieldLabel>
              <Input
                id="relay-url"
                placeholder="http://localhost:9181"
                autoComplete="url"
                value={relay.url}
                onChange={(event) => set({ url: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="relay-token">Relay token</FieldLabel>
              <Input
                id="relay-token"
                type="password"
                autoComplete="off"
                placeholder="From the relay's startup log"
                value={relay.token}
                onChange={(event) => set({ token: event.target.value })}
              />
            </Field>
          </div>
          <FieldDescription>
            Saved in this browser. From an HTTPS page the browser asks once to allow local network access; allow it. A relay on another machine
            needs HTTPS (a reverse proxy or a real certificate), since browsers block plain-http private addresses from HTTPS pages.
          </FieldDescription>
          {result && "problem" in result ? (
            <Alert variant="destructive" role="alert" data-problem={result.problem.kind}>
              <WarningCircleIcon />
              <AlertTitle>{result.problem.title}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{result.problem.detail}</span>
                {result.problem.snippet ? <CodeBlock code={result.problem.snippet} className="w-full" /> : null}
              </AlertDescription>
            </Alert>
          ) : result ? (
            <p className="flex items-center gap-1.5 text-sm text-brand-ink" role="status">
              <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
              Cardinal server {result.info.version} answered in {result.info.latencyMs} ms; this origin and the token are allowed.
            </p>
          ) : null}
          <Field orientation="horizontal">
            <Button type="button" variant="outline" disabled={testing || !relay.url.trim()} onClick={() => void test()}>
              {testing ? <Spinner data-icon="inline-start" /> : <PulseIcon data-icon="inline-start" />}
              Test relay
            </Button>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
