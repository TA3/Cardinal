import * as React from "react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ownServerProblem, type ConnectionProblem } from "@/features/settings/connection-check"
import { ProblemLine } from "@/features/settings/problem-line"
import { LOCAL_APP_URL } from "@/lib/core/own-server"
import { checkProxyServer, proxyServerOrigin } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/server-store"

// The user's own Cardinal server as the proxy for this page: the hosted app
// has none. Saved only once the server answers and lets this page in.

type Status = { kind: "idle" } | { kind: "checking" } | { kind: "ok"; version: string } | { kind: "error"; problem: ConnectionProblem }

export function ProxyServerField({ id = "proxy-server" }: { id?: string }) {
  const selfHosted = useSelfHosted()
  const saved = useAppStore((state) => state.proxyServer)
  const setProxyServer = useAppStore((state) => state.setProxyServer)
  const queryClient = useQueryClient()
  const [draft, setDraft] = React.useState(saved || LOCAL_APP_URL)
  const [status, setStatus] = React.useState<Status>({ kind: "idle" })

  if (selfHosted) {
    return (
      <p className="text-sm text-muted-foreground">
        The Cardinal server you run serves this page, so it is the proxy already. Nothing to set up.
      </p>
    )
  }

  async function use() {
    setStatus({ kind: "checking" })
    try {
      const info = await checkProxyServer(draft, AbortSignal.timeout(8_000))
      const origin = proxyServerOrigin(draft)!
      setDraft(origin)
      setProxyServer(origin)
      setStatus({ kind: "ok", version: info.version })
      // Requests that failed for want of a proxy can go through it now.
      void queryClient.invalidateQueries()
      toast.success(`Using your Cardinal server ${info.version}`, { description: `Proxy mode now goes through ${origin}.` })
    } catch (error) {
      const problem = ownServerProblem(error)
      setStatus({
        kind: "error",
        problem: problem ?? { kind: "server", title: error instanceof Error ? error.message : String(error), detail: "" },
      })
    }
  }

  function stop() {
    setProxyServer("")
    setStatus({ kind: "idle" })
    toast.success("Stopped using your Cardinal server", { description: "Proxy mode has nowhere to go until you set one again." })
  }

  const unchanged = proxyServerOrigin(draft) === saved && saved !== ""
  return (
    <Field>
      <FieldLabel htmlFor={id}>Server address</FieldLabel>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void use()
        }}
      >
        <Input
          id={id}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setStatus({ kind: "idle" })
          }}
          placeholder={LOCAL_APP_URL}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 basis-56 font-mono text-sm"
        />
        <Button type="submit" variant={unchanged ? "outline" : "default"} disabled={status.kind === "checking"}>
          {status.kind === "checking" ? <Spinner data-icon="inline-start" /> : null}
          {unchanged ? "Check" : "Use it"}
        </Button>
        {saved ? (
          <Button type="button" variant="ghost" onClick={stop}>
            Stop using
          </Button>
        ) : null}
      </form>
      {status.kind === "error" ? (
        <ProblemLine problem={status.problem} />
      ) : status.kind === "ok" ? (
        <p className="flex items-center gap-1.5 text-sm text-brand-ink">
          <CheckCircleIcon className="size-4" weight="fill" />
          Cardinal {status.version} answered: this page uses it as its proxy.
        </p>
      ) : (
        <FieldDescription>
          {saved
            ? `Proxy mode goes through ${saved}: from this page to your server, from there to the backend.`
            : "Start it with --allow-origin set to this page, then use it. Cardinal checks it answers first."}
        </FieldDescription>
      )}
    </Field>
  )
}
