import * as React from "react"

import { executeTool } from "@/lib/agent/executor"
import {
  CLOSE_BAD_AUTH,
  CLOSE_SESSION_ENDED,
  CLOSE_TAKEN_OVER,
  PING_INTERVAL_MS,
  type CreatedSession,
  type ServerToBrowser,
  type ToolResultMessage,
} from "@/lib/agent/protocol"
import { CLIENT_HEADER } from "@/lib/sources/proxy-constants"
import { loadAgentSession, storeAgentSession, useAppStore } from "@/lib/store/app-store"

// Keeps this tab attached to its agent session: receives relayed tool calls
// over the WebSocket, runs them locally and sends results back.
//
// "Duplicate tab" copies sessionStorage, so two tabs can hold the same session.
// Tabs agree on one owner over a BroadcastChannel; the others report
// "elsewhere" until the user takes over with takeOverAgentSession().

const MAX_BACKOFF_RETRIES = 8
const OWNER_QUERY_MS = 300

type OwnershipMessage =
  | { type: "query"; sessionId: string; tabId: string }
  | { type: "owned"; sessionId: string; tabId: string }
  | { type: "claim"; sessionId: string; tabId: string; at: number }

const tabId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random())
let channel: BroadcastChannel | null | undefined
/** Session this tab currently owns, and when it claimed it. */
let ownedSessionId: string | null = null
let claimedAt = 0
/** Hooks for the mounted bridge, so module-level events can reach it. */
let activeLink: { sessionId: string; yieldToOtherTab: () => void; takeOver: () => void } | null = null
const ownerReplies = new Set<(sessionId: string) => void>()

function ownershipChannel() {
  if (channel !== undefined) return channel
  channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("cardinal.agent-session")
  channel?.addEventListener("message", (event: MessageEvent<OwnershipMessage>) => {
    const message = event.data
    if (!message || message.tabId === tabId) return
    if (message.type === "query" && message.sessionId === ownedSessionId) {
      channel?.postMessage({ type: "owned", sessionId: message.sessionId, tabId } satisfies OwnershipMessage)
    } else if (message.type === "owned") {
      for (const reply of ownerReplies) reply(message.sessionId)
    } else if (message.type === "claim" && message.sessionId === ownedSessionId) {
      // Two tabs claiming at once: the later claim wins, ties go to the higher tab id.
      if (message.at < claimedAt || (message.at === claimedAt && message.tabId < tabId)) return
      ownedSessionId = null
      if (activeLink?.sessionId === message.sessionId) activeLink.yieldToOtherTab()
    }
  })
  return channel
}

function claimSession(sessionId: string) {
  ownedSessionId = sessionId
  claimedAt = Date.now()
  ownershipChannel()?.postMessage({ type: "claim", sessionId, tabId, at: claimedAt } satisfies OwnershipMessage)
}

/** Resolves true when another open tab already owns this session. */
function ownedElsewhere(sessionId: string): Promise<boolean> {
  const bus = ownershipChannel()
  if (!bus) return Promise.resolve(false)
  return new Promise((resolve) => {
    const reply = (owned: string) => {
      if (owned !== sessionId) return
      finish(true)
    }
    const timer = setTimeout(() => finish(false), OWNER_QUERY_MS)
    function finish(result: boolean) {
      clearTimeout(timer)
      ownerReplies.delete(reply)
      resolve(result)
    }
    ownerReplies.add(reply)
    bus.postMessage({ type: "query", sessionId, tabId } satisfies OwnershipMessage)
  })
}

type SessionCheck = "alive" | "gone" | "unknown"

/** Only a 404 from the status endpoint proves the session is gone. */
async function checkSession(session: CreatedSession): Promise<SessionCheck> {
  try {
    const response = await fetch(`/api/sessions/${session.sessionId}`, {
      headers: { "X-Browser-Key": session.browserKey, [CLIENT_HEADER]: "1" },
      cache: "no-store",
    })
    if (response.status === 404) return "gone"
    return response.ok ? "alive" : "unknown"
  } catch {
    return "unknown"
  }
}

function socketUrl(session: CreatedSession) {
  const url = new URL(`/api/sessions/${session.sessionId}/ws`, window.location.origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function summarize(args: unknown) {
  const text = JSON.stringify(args ?? {})
  return text === "{}" ? undefined : text.length > 120 ? `${text.slice(0, 117)}…` : text
}

export function useAgentBridge() {
  const session = useAppStore((state) => state.agentSession)
  const setAgentSession = useAppStore((state) => state.setAgentSession)

  React.useEffect(() => {
    const restored = loadAgentSession()
    if (restored) setAgentSession(restored)
  }, [setAgentSession])

  React.useEffect(() => {
    if (!session) return
    const { setAgentStatus, recordAgentActivity } = useAppStore.getState()
    let socket: WebSocket | null = null
    let retry = 0
    let stopped = false
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const inFlight = new Map<string, AbortController>()

    const abortInFlight = (reason: string) => {
      for (const controller of inFlight.values()) controller.abort(new Error(reason))
      inFlight.clear()
    }

    const forget = () => {
      stopped = true
      if (ownedSessionId === session.sessionId) ownedSessionId = null
      storeAgentSession(null)
      setAgentStatus("expired")
    }

    const disconnect = () => {
      clearInterval(pingTimer)
      clearTimeout(retryTimer)
      const current = socket
      socket = null
      current?.close(1000)
      abortInFlight("The agent connection moved or closed")
    }

    const runCall = async (target: WebSocket, message: Extract<ServerToBrowser, { type: "call" }>) => {
      const controller = new AbortController()
      inFlight.set(message.id, controller)
      let reply: ToolResultMessage
      const at = new Date().toISOString()
      const started = performance.now()
      const timing = () => ({ at, args: message.args, durationMs: Math.round(performance.now() - started) })
      try {
        const result = await executeTool(message.tool, message.args, { signal: controller.signal })
        reply = { type: "result", id: message.id, ok: true, result }
        recordAgentActivity({ ...timing(), tool: message.tool, ok: true, detail: summarize(message.args) })
      } catch (error) {
        const text = controller.signal.aborted
          ? "Cancelled: the agent stopped waiting for this call"
          : error instanceof Error
            ? error.message
            : String(error)
        reply = { type: "result", id: message.id, ok: false, error: text }
        recordAgentActivity({ ...timing(), tool: message.tool, ok: false, detail: text })
      } finally {
        inFlight.delete(message.id)
      }
      if (!controller.signal.aborted && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(reply))
    }

    // Decides what to do after the socket closed or never opened.
    const recover = async (code: number) => {
      if (code === CLOSE_TAKEN_OVER) {
        if (ownedSessionId === session.sessionId) ownedSessionId = null
        setAgentStatus("elsewhere")
        return
      }
      setAgentStatus(code === CLOSE_SESSION_ENDED ? "expired" : "disconnected")
      const check = await checkSession(session)
      if (stopped) return
      if (check === "gone") {
        forget()
        return
      }
      if (code === CLOSE_SESSION_ENDED && check === "unknown") return
      setAgentStatus("disconnected")
      retry += 1
      // Out of backoff retries: wait for the online / visibilitychange listeners.
      if (retry > MAX_BACKOFF_RETRIES) return
      retryTimer = setTimeout(connect, code === CLOSE_BAD_AUTH ? 5_000 : Math.min(30_000, 1000 * 2 ** retry))
    }

    const connect = () => {
      clearTimeout(retryTimer)
      if (stopped || socket || ownedSessionId !== session.sessionId) return
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        setAgentStatus("expired")
        return
      }
      setAgentStatus("connecting")
      const current = new WebSocket(socketUrl(session))
      socket = current

      current.onopen = () => {
        current.send(JSON.stringify({ type: "auth", key: session.browserKey }))
        pingTimer = setInterval(() => {
          if (current.readyState === WebSocket.OPEN) current.send("ping")
        }, PING_INTERVAL_MS)
      }

      current.onmessage = (event) => {
        if (event.data === "pong") return
        let message: ServerToBrowser
        try {
          message = JSON.parse(String(event.data)) as ServerToBrowser
        } catch {
          return
        }
        if (message.type === "status") {
          // The server only talks to authenticated sockets.
          retry = 0
          setAgentStatus("connected")
        } else if (message.type === "cancel") {
          inFlight.get(message.id)?.abort(new Error("Cancelled by the session"))
        } else if (message.type === "call") {
          void runCall(current, message)
        }
      }

      current.onclose = (event) => {
        if (socket !== current) return
        socket = null
        clearInterval(pingTimer)
        abortInFlight("The Cardinal tab lost its agent connection")
        if (stopped) return
        void recover(event.code)
      }
    }

    // After the backoff runs out, a network change or a return to the tab
    // tries again; a visible tab also refreshes its heartbeat right away.
    const wake = () => {
      if (stopped || document.visibilityState === "hidden") return
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send("ping")
        return
      }
      if (!socket && ownedSessionId === session.sessionId) {
        retry = 0
        connect()
      }
    }
    window.addEventListener("online", wake)
    document.addEventListener("visibilitychange", wake)

    activeLink = {
      sessionId: session.sessionId,
      yieldToOtherTab: () => {
        disconnect()
        if (!stopped) setAgentStatus("elsewhere")
      },
      takeOver: () => {
        if (stopped) return
        claimSession(session.sessionId)
        retry = 0
        connect()
      },
    }

    if (ownedSessionId === session.sessionId) {
      connect()
    } else {
      setAgentStatus("connecting")
      void ownedElsewhere(session.sessionId).then((elsewhere) => {
        if (stopped) return
        if (elsewhere) {
          setAgentStatus("elsewhere")
          return
        }
        claimSession(session.sessionId)
        connect()
      })
    }

    return () => {
      stopped = true
      window.removeEventListener("online", wake)
      document.removeEventListener("visibilitychange", wake)
      if (activeLink?.sessionId === session.sessionId) activeLink = null
      disconnect()
    }
  }, [session])
}

/** Moves the agent session to this tab when another tab holds it ("elsewhere"). */
export function takeOverAgentSession() {
  activeLink?.takeOver()
}

export async function startAgentSession() {
  const response = await fetch("/api/sessions", { method: "POST", headers: { [CLIENT_HEADER]: "1" } })
  if (!response.ok) throw new Error(`Could not start an agent session (HTTP ${response.status})`)
  const session = (await response.json()) as CreatedSession
  // A fresh session belongs to this tab; no need to ask the others.
  claimSession(session.sessionId)
  storeAgentSession(session)
  useAppStore.getState().setAgentSession(session)
  return session
}

export async function endAgentSession() {
  const session = useAppStore.getState().agentSession
  if (session && ownedSessionId === session.sessionId) ownedSessionId = null
  storeAgentSession(null)
  useAppStore.getState().setAgentSession(null)
  if (!session) return
  await fetch(`/api/sessions/${session.sessionId}`, {
    method: "DELETE",
    headers: { "X-Browser-Key": session.browserKey, [CLIENT_HEADER]: "1" },
  }).catch(() => undefined)
}
