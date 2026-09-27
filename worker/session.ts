import { DurableObject } from "cloudflare:workers"

import {
  AUTH_TIMEOUT_MS,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_BAD_AUTH,
  CLOSE_SESSION_ENDED,
  CLOSE_TAKEN_OVER,
  IDLE_TTL_MS,
  MAX_CALLS_PER_MINUTE,
  SESSION_TTL_MS,
  TAB_STALE_MS,
  TOOL_CALL_TIMEOUT_MS,
  type BrowserToServer,
  type ServerToBrowser,
} from "@/lib/agent/protocol"
import { safeEqual, sha256Hex } from "./tokens"

// One Durable Object per agent session. It holds the WebSocket to the Cardinal
// tab and relays MCP tool calls to it. It never sees backend credentials: the
// tab runs every query itself.

interface SessionRecord {
  agentSecretHash: string
  browserKeyHash: string
  createdAt: number
  expiresAt: number
  lastActivity: number
  calls: number
  /** Start times of calls in the last minute; persisted so eviction does not reset the limit. */
  recentCalls?: number[]
}

/** Per-socket state, kept with serializeAttachment so it survives hibernation. */
interface SocketState {
  id: string
  openedAt: number
  authedAt?: number
  /** Last non-ping message from the tab; pings are tracked by the runtime. */
  lastSeenAt?: number
}

interface PendingCall {
  socketId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SessionUnavailableError extends Error {}

const TAB_NOT_OPEN =
  "The Cardinal tab for this session is not open. Ask the user to open Cardinal and reconnect the agent session."

export class CardinalSession extends DurableObject<Env> {
  private pending = new Map<string, PendingCall>()

  private async record(): Promise<SessionRecord | null> {
    const record = await this.ctx.storage.get<SessionRecord>("session")
    if (!record) return null
    const now = Date.now()
    if (now > record.expiresAt || now - record.lastActivity > IDLE_TTL_MS) {
      await this.destroy()
      return null
    }
    return record
  }

  async init(input: { agentSecretHash: string; browserKeyHash: string }) {
    if (await this.ctx.storage.get("session")) throw new Error("Session already exists")
    const now = Date.now()
    const record: SessionRecord = { ...input, createdAt: now, expiresAt: now + SESSION_TTL_MS, lastActivity: now, calls: 0 }
    await this.ctx.storage.put("session", record)
    await this.ctx.storage.setAlarm(now + IDLE_TTL_MS)
    return { expiresAt: new Date(record.expiresAt).toISOString() }
  }

  async authorizeAgent(secret: string) {
    const record = await this.record()
    if (!record) return false
    return safeEqual(await sha256Hex(secret), record.agentSecretHash)
  }

  /** Session status for the owning tab, or null when the session is gone or the key is wrong. */
  async status(browserKey: string) {
    const record = await this.record()
    if (!record || !safeEqual(await sha256Hex(browserKey), record.browserKeyHash)) return null
    return { calls: record.calls, expiresAt: new Date(record.expiresAt).toISOString() }
  }

  async revoke(browserKey: string) {
    const record = await this.record()
    if (!record || !safeEqual(await sha256Hex(browserKey), record.browserKeyHash)) return false
    await this.destroy()
    return true
  }

  /**
   * WebSocket attach: /api/sessions/:id/ws. The socket is accepted but stays
   * unauthenticated, and never receives calls, until its first message is a
   * valid {type:"auth", key}.
   */
  async fetch(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 })
    if (!(await this.record())) return new Response("Unknown or expired session", { status: 404 })
    this.closeUnauthenticated()

    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    const state: SocketState = { id: crypto.randomUUID(), openedAt: Date.now() }
    pair[1].serializeAttachment(state)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
    // Best effort: if the object hibernates first, alarm() and the next message sweep instead.
    setTimeout(() => this.closeUnauthenticated(), AUTH_TIMEOUT_MS + 250)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return
    let message: BrowserToServer
    try {
      message = JSON.parse(raw) as BrowserToServer
    } catch {
      return
    }
    const state = this.socketState(socket)
    if (!state) return
    const now = Date.now()

    if (!state.authedAt) {
      await this.authenticate(socket, state, message)
      return
    }
    socket.serializeAttachment({ ...state, lastSeenAt: now } satisfies SocketState)

    if (message.type !== "result") return
    const call = this.pending.get(message.id)
    if (!call || call.socketId !== state.id) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)
    if (message.ok) call.resolve(message.result)
    else call.reject(new Error(message.error ?? "Tool failed in the Cardinal tab"))
  }

  async webSocketClose(socket: WebSocket) {
    this.dropSocket(socket, "The Cardinal tab disconnected during the call")
    try {
      socket.close()
    } catch {
      // already closed
    }
  }

  async webSocketError(socket: WebSocket) {
    this.dropSocket(socket, "The Cardinal tab connection failed during the call")
  }

  /** Relays one MCP tool call to the tab and waits for its answer. */
  async callTool(tool: string, args: unknown): Promise<unknown> {
    const record = await this.record()
    if (!record) throw new SessionUnavailableError("This Cardinal session has expired or was revoked")

    const now = Date.now()
    const live = this.liveSocket()
    if (!live) throw new SessionUnavailableError(TAB_NOT_OPEN)
    const { socket, state } = live
    const lastSeen = Math.max(
      this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
      state.lastSeenAt ?? 0,
      state.authedAt ?? 0
    )
    if (now - lastSeen > TAB_STALE_MS) {
      throw new SessionUnavailableError(
        "The Cardinal tab is not responding (no heartbeat for over a minute). Ask the user to bring the Cardinal tab back or reload it."
      )
    }

    // Only calls that reach a live tab count against the limit.
    const recentCalls = (record.recentCalls ?? []).filter((time) => now - time < 60_000)
    if (recentCalls.length >= MAX_CALLS_PER_MINUTE) {
      throw new Error(`Rate limit: at most ${MAX_CALLS_PER_MINUTE} tool calls per minute`)
    }
    recentCalls.push(now)
    record.recentCalls = recentCalls
    record.lastActivity = now
    record.calls += 1
    await this.ctx.storage.put("session", record)

    const id = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Tell the tab to stop; nobody is waiting for the answer any more.
        this.trySend(socket, { type: "cancel", id })
        reject(new Error(`The Cardinal tab did not answer within ${TOOL_CALL_TIMEOUT_MS / 1000}s`))
      }, TOOL_CALL_TIMEOUT_MS)
      this.pending.set(id, { socketId: state.id, resolve, reject, timer })
    })

    try {
      this.send(socket, { type: "call", id, tool, args })
    } catch {
      const call = this.pending.get(id)
      if (call) clearTimeout(call.timer)
      this.pending.delete(id)
      throw new SessionUnavailableError("Could not reach the Cardinal tab; it may have just closed. Try again shortly.")
    }
    this.trySend(socket, { type: "status", calls: record.calls, expiresAt: new Date(record.expiresAt).toISOString() })
    return result
  }

  async alarm() {
    this.closeUnauthenticated()
    const record = await this.record()
    if (record) await this.ctx.storage.setAlarm(Math.min(record.expiresAt, record.lastActivity + IDLE_TTL_MS))
  }

  private async authenticate(socket: WebSocket, state: SocketState, message: BrowserToServer) {
    const now = Date.now()
    if (now - state.openedAt > AUTH_TIMEOUT_MS) {
      this.tryClose(socket, CLOSE_AUTH_TIMEOUT, "Authentication timed out")
      return
    }
    if (message.type !== "auth" || typeof message.key !== "string") {
      this.tryClose(socket, CLOSE_BAD_AUTH, "Authenticate first")
      return
    }
    const record = await this.record()
    if (!record) {
      this.tryClose(socket, CLOSE_SESSION_ENDED, "Session ended")
      return
    }
    if (!safeEqual(await sha256Hex(message.key), record.browserKeyHash)) {
      this.tryClose(socket, CLOSE_BAD_AUTH, "Invalid session key")
      return
    }
    socket.serializeAttachment({ ...state, authedAt: now, lastSeenAt: now } satisfies SocketState)

    // A reopened tab takes over the session.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket && this.socketState(other)?.authedAt) this.tryClose(other, CLOSE_TAKEN_OVER, "Replaced by a newer tab")
    }
    this.trySend(socket, { type: "status", calls: record.calls, expiresAt: new Date(record.expiresAt).toISOString() })
  }

  /** Newest authenticated socket that is still open. */
  private liveSocket(): { socket: WebSocket; state: SocketState } | null {
    let best: { socket: WebSocket; state: SocketState } | null = null
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.socketState(socket)
      if (!state?.authedAt || socket.readyState !== WebSocket.OPEN) continue
      if (!best || state.authedAt > (best.state.authedAt ?? 0)) best = { socket, state }
    }
    return best
  }

  private closeUnauthenticated() {
    const now = Date.now()
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.socketState(socket)
      if (state && !state.authedAt && now - state.openedAt > AUTH_TIMEOUT_MS) {
        this.tryClose(socket, CLOSE_AUTH_TIMEOUT, "Authentication timed out")
      }
    }
  }

  /** Rejects the calls that were sent on this socket, and only those. */
  private dropSocket(socket: WebSocket, reason: string) {
    const socketId = this.socketState(socket)?.id
    if (!socketId) return
    for (const [id, call] of this.pending) {
      if (call.socketId !== socketId) continue
      clearTimeout(call.timer)
      call.reject(new SessionUnavailableError(reason))
      this.pending.delete(id)
    }
  }

  private socketState(socket: WebSocket) {
    return socket.deserializeAttachment() as SocketState | null
  }

  private send(socket: WebSocket, message: ServerToBrowser) {
    socket.send(JSON.stringify(message))
  }

  private trySend(socket: WebSocket, message: ServerToBrowser) {
    try {
      this.send(socket, message)
    } catch {
      // The socket closed; webSocketClose cleans up.
    }
  }

  private tryClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason)
    } catch {
      // already closing
    }
  }

  private async destroy() {
    for (const socket of this.ctx.getWebSockets()) this.tryClose(socket, CLOSE_SESSION_ENDED, "Session ended")
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
}
