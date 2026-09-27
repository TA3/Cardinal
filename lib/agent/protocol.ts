// Messages exchanged over the WebSocket between a session Durable Object and
// the Cardinal tab that owns the session.

export interface ToolCallMessage {
  type: "call"
  id: string
  tool: string
  args: unknown
}

/** The Durable Object gave up on a call (timeout); the tab should stop working on it. */
export interface ToolCancelMessage {
  type: "cancel"
  id: string
}

export interface ToolResultMessage {
  type: "result"
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/** First message on every socket. The key never travels in the URL, so it stays out of logs. */
export interface AuthMessage {
  type: "auth"
  key: string
}

export interface AgentStatusMessage {
  type: "status"
  /** Number of MCP requests seen in this session. */
  calls: number
  expiresAt: string
}

export type ServerToBrowser = ToolCallMessage | ToolCancelMessage | AgentStatusMessage
export type BrowserToServer = AuthMessage | ToolResultMessage

export interface CreatedSession {
  sessionId: string
  /** Bearer token for the MCP client. Shown once; only its hash is stored. */
  agentToken: string
  /** Key the tab uses to authenticate its WebSocket. Only its hash is stored. */
  browserKey: string
  mcpUrl: string
  expiresAt: string
}

/** WebSocket close codes the Durable Object uses. */
export const CLOSE_TAKEN_OVER = 4000
export const CLOSE_SESSION_ENDED = 4001
export const CLOSE_BAD_AUTH = 4003
export const CLOSE_AUTH_TIMEOUT = 4008

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000
export const IDLE_TTL_MS = 60 * 60 * 1000
export const TOOL_CALL_TIMEOUT_MS = 60_000
export const MAX_CALLS_PER_MINUTE = 60
/** How long a new socket has to send its auth message. */
export const AUTH_TIMEOUT_MS = 5_000
export const PING_INTERVAL_MS = 20_000
/**
 * A tab whose last ping is older than this is treated as gone. Chrome throttles
 * timers in long-hidden tabs to once a minute, so this sits just above 60s to
 * avoid failing calls to a healthy background tab.
 */
export const TAB_STALE_MS = 70_000
