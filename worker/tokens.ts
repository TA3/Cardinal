// Session credentials. The agent token embeds the session id so the Worker can
// route to the right Durable Object; the secret half is only ever stored hashed.

const TOKEN_PREFIX = "cdl_"
const SESSION_ID_LENGTH = 32

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function newSessionId() {
  return toHex(randomBytes(SESSION_ID_LENGTH / 2))
}

export function newSecret() {
  return toBase64Url(randomBytes(32))
}

export function isSessionId(value: string) {
  return new RegExp(`^[0-9a-f]{${SESSION_ID_LENGTH}}$`).test(value)
}

export function formatAgentToken(sessionId: string, secret: string) {
  return `${TOKEN_PREFIX}${sessionId}_${secret}`
}

export function parseAgentToken(token: string): { sessionId: string; secret: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const body = token.slice(TOKEN_PREFIX.length)
  const sessionId = body.slice(0, SESSION_ID_LENGTH)
  const secret = body.slice(SESSION_ID_LENGTH + 1)
  if (!isSessionId(sessionId) || body[SESSION_ID_LENGTH] !== "_" || secret.length < 32) return null
  return { sessionId, secret }
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return toHex(new Uint8Array(digest))
}

export function safeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  if (left.byteLength !== right.byteLength) return false
  let diff = 0
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i]
  return diff === 0
}
