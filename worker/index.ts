import { createMcpHandler } from "agents/mcp/server"
import { Hono, type Context } from "hono"

import type { CreatedSession } from "@/lib/agent/protocol"
import { PROXY_PREFIX, PROXY_TOKEN_PATH } from "@/lib/sources/proxy-constants"
import { clientIp, isSameOrigin, issueProxyToken } from "./guard"
import { buildMcpServer } from "./mcp"
import { handleProxy } from "./proxy"
import { formatAgentToken, isSessionId, newSecret, newSessionId, parseAgentToken, sha256Hex } from "./tokens"

export { CardinalSession } from "./session"

// PROXY_SECRET is an optional secret (wrangler secret put / .dev.vars), so it
// is not part of the generated Env.
type Bindings = Env & { PROXY_SECRET?: string }

const app = new Hono<{ Bindings: Bindings }>()

const NO_STORE = { "Cache-Control": "no-store" }

function sessionStub(env: Env, sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(sessionId))
}

/** Same-origin plus per-IP rate limit, for endpoints only the Cardinal page should call. */
async function guardPage(c: Context<{ Bindings: Bindings }>, limiter: RateLimit, prefix: string) {
  if (!isSameOrigin(c.req.raw)) return c.json({ error: "Forbidden" }, 403)
  const { success } = await limiter.limit({ key: `${prefix}:${clientIp(c.req.raw)}` })
  if (!success) return c.json({ error: "Too many requests, slow down" }, 429)
  return null
}

app.all(`${PROXY_PREFIX}/*`, async (c) => {
  const { success } = await c.env.PROXY_LIMITER.limit({ key: clientIp(c.req.raw) })
  if (!success) return c.json({ error: "Too many proxy requests, slow down" }, 429)
  return handleProxy(c.req.raw, c.env.PROXY_SECRET)
})

app.get(PROXY_TOKEN_PATH, async (c) => {
  const denied = await guardPage(c, c.env.PROXY_LIMITER, "token")
  if (denied) return denied
  return c.json(await issueProxyToken(c.env.PROXY_SECRET, clientIp(c.req.raw)), 200, NO_STORE)
})

// A tab starts an agent session. The response carries both secrets exactly once.
app.post("/api/sessions", async (c) => {
  const denied = await guardPage(c, c.env.SESSION_LIMITER, "session")
  if (denied) return denied

  const sessionId = newSessionId()
  const agentSecret = newSecret()
  const browserKey = newSecret()
  const { expiresAt } = await sessionStub(c.env, sessionId).init({
    agentSecretHash: await sha256Hex(agentSecret),
    browserKeyHash: await sha256Hex(browserKey),
  })

  const body: CreatedSession = {
    sessionId,
    agentToken: formatAgentToken(sessionId, agentSecret),
    browserKey,
    mcpUrl: new URL("/mcp", c.req.url).toString(),
    expiresAt,
  }
  return c.json(body, 201, NO_STORE)
})

// Lets a tab tell "session gone" (404) apart from "network trouble" before it
// forgets its stored session.
app.get("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id")
  const key = c.req.header("X-Browser-Key") ?? ""
  const status = isSessionId(sessionId) ? await sessionStub(c.env, sessionId).status(key) : null
  if (!status) return c.json({ error: "Not found" }, 404, NO_STORE)
  return c.json(status, 200, NO_STORE)
})

// The key is not in the URL: the socket authenticates with its first message.
app.get("/api/sessions/:id/ws", async (c) => {
  const sessionId = c.req.param("id")
  if (!isSessionId(sessionId)) return c.text("Not found", 404)
  return sessionStub(c.env, sessionId).fetch(c.req.raw)
})

app.delete("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id")
  const key = c.req.header("X-Browser-Key") ?? ""
  if (!isSessionId(sessionId) || !(await sessionStub(c.env, sessionId).revoke(key))) {
    return c.json({ error: "Not found" }, 404)
  }
  return c.body(null, 204)
})

function publicHostnames(env: Env) {
  const hosts = (env.PUBLIC_HOSTNAMES ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
  return hosts.length ? hosts : undefined
}

async function serveMcp(request: Request, env: Env, token: string | undefined) {
  const parsed = token ? parseAgentToken(token) : null
  const stub = parsed ? sessionStub(env, parsed.sessionId) : null
  if (!parsed || !stub || !(await stub.authorizeAgent(parsed.secret))) {
    return new Response(JSON.stringify({ error: "Unknown, expired or revoked Cardinal session" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="cardinal"' },
    })
  }
  const handler = createMcpHandler(() => buildMcpServer(stub), {
    route: "/mcp",
    allowedHostnames: publicHostnames(env),
  })
  return handler.fetch(request, { authInfo: { token: token!, clientId: parsed.sessionId, scopes: [] } })
}

app.all("/mcp", (c) => serveMcp(c.req.raw, c.env, c.req.header("Authorization")?.replace(/^Bearer\s+/i, "")))

// For MCP clients that only accept a URL: the token rides in the path and is
// rewritten away before the MCP handler sees the request. Prefer the Bearer
// header where the client supports it, since URLs end up in logs and history.
app.all("/mcp/:token", (c) => {
  const url = new URL(c.req.url)
  url.pathname = "/mcp"
  return serveMcp(new Request(url, c.req.raw), c.env, c.req.param("token"))
})

export default app satisfies ExportedHandler<Env>
