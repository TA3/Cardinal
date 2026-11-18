import { ArrowSquareOutIcon, InfoIcon } from "@phosphor-icons/react"
import { Link } from "react-router"

import { paths } from "@/app/paths"
import { CodeBlock } from "@/components/code-block"
import { Button } from "@/components/ui/button"
import { corsFlag } from "@/features/settings/connection-check"
import { handoffUrl, LOCAL_APP_URL, type HandoffConnection } from "@/lib/core/handoff"
import { proxyCommand } from "@/lib/core/own-server"
import type { Signal } from "@/lib/core/signals"
import { localBackendAdvice } from "@/lib/core/transport-plan"
import { isPrivateHost } from "@/lib/sources/proxy-constants"
import { supportsLocalNetworkAccess } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"
import { useSelfHosted } from "@/lib/store/server-store"

// A backend on the user's network, from the hosted (https) page: say what the
// browser will do before they try, and offer the way that always works, the
// local `cardinal` server: open it with everything carried over
// (lib/core/handoff), or set it as this page's proxy.

/** Opens the local app with this browser's work and, if given, the connection being typed. Tokens stay here. */
export function ContinueLocallyButton({
  signal,
  draft,
  variant = "default",
}: {
  signal: Signal
  draft?: HandoffConnection
  variant?: "default" | "outline"
}) {
  const open = () => {
    const state = useAppStore.getState()
    const saved = (settings: { baseUrl: string; instanceId: string; tenant: string }) =>
      settings.baseUrl.trim() ? { baseUrl: settings.baseUrl, instanceId: settings.instanceId, tenant: settings.tenant } : undefined
    // The user's server as set for this page (it may serve https), else the default address.
    const base = state.proxyServer || LOCAL_APP_URL
    const url = handoffUrl({
      metrics: signal === "metrics" && draft ? draft : saved(state.settings),
      logs: signal === "logs" && draft ? draft : saved(state.logsSettings),
      grafana: state.grafanaSettings.baseUrl.trim() ? { baseUrl: state.grafanaSettings.baseUrl } : undefined,
      rules: state.rules,
      logRules: state.logRules,
      prices: { perSeries: state.settings.pricePer1kSeries, perGB: state.settings.pricePerGB },
      autopilot: state.autopilot,
      attribution: state.attribution,
      open: signal,
    }, base)
    window.open(url, "_blank", "noopener")
  }
  return (
    <Button type="button" size="sm" variant={variant} onClick={open}>
      Continue on your machine
      <ArrowSquareOutIcon data-icon="inline-end" />
    </Button>
  )
}

function hostname(url: string) {
  try {
    return new URL(url.trim())
  } catch {
    return null
  }
}

/** Shown under the URL field when the hosted page is about to call a backend on a private network. */
export function LocalBackendNotice({ signal, draft }: { signal: Signal; draft: HandoffConnection }) {
  const selfHosted = useSelfHosted()
  const proxyServer = useAppStore((state) => state.proxyServer)
  const target = hostname(draft.baseUrl)
  const advice = target
    ? localBackendAdvice({
        pageHttps: globalThis.location?.protocol === "https:",
        privateHost: isPrivateHost(target.hostname),
        plainHttp: target.protocol === "http:",
        ownServer: selfHosted || proxyServer !== "",
        localNetworkAccess: supportsLocalNetworkAccess(),
      })
    : null
  if (!advice || !target) return null
  const origin = globalThis.location.origin
  const carried = "Your URLs, rules and prices come along; tokens don't."

  return (
    <div role="note" className="flex flex-col gap-3 rounded-xl border border-well-border bg-background/60 p-3 text-sm">
      <p className="flex items-start gap-2">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          {advice === "blocked" ? (
            <>
              <span className="font-medium">This browser won&apos;t reach http:// on your network from this page.</span>{" "}
              <span className="text-muted-foreground">
                Safari and Firefox block it. Run Cardinal on your machine: it reaches {target.host} without CORS. Continue there, or keep this page and set your server as its proxy. {carried}
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">
                {advice === "local-network" ? "Chrome will ask to reach your network the first time" : `${target.host} is on your network`}, and{" "}
                {advice === "local-network" ? target.host : "it"} must allow {origin} (CORS).
              </span>{" "}
              <span className="text-muted-foreground">
                {signal === "metrics"
                  ? "For Prometheus, start it with the flag below. Or skip CORS: run Cardinal on your machine and use it as this page's proxy."
                  : "For Loki, allow this origin in the proxy in front of it. Or skip CORS: run Cardinal on your machine and use it as this page's proxy."}
              </span>
            </>
          )}
        </span>
      </p>
      {advice !== "blocked" && signal === "metrics" ? <CodeBlock code={corsFlag(origin)} /> : null}
      {advice === "blocked" ? <CodeBlock code={proxyCommand(origin)} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <ContinueLocallyButton signal={signal} draft={draft} variant={advice === "blocked" ? "default" : "outline"} />
        <Link to={paths.ownServer} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {advice === "blocked" ? "Use it as this page's proxy, or install without Node" : "How to run it yourself"}
        </Link>
      </div>
    </div>
  )
}
