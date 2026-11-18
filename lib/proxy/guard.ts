// Request guards for the self-hosted server's proxy (server/), and the
// same-origin check the Worker's session endpoints use too.
//
// Honest scope: these checks keep other sites and scripts from using the
// proxy, but they are not a hard guarantee against someone who can already
// open the app: they can mint a proxy token and replay it with a non-browser
// client until it expires. What they buy is that drive-by cross-site use
// fails and tokens are bound to one client IP and die within minutes.

import { CLIENT_HEADER } from "@/lib/sources/proxy-constants"

const PROXY_TOKEN_TTL_SECONDS = 10 * 60

/**
 * The request came from a Cardinal page on this origin. Browsers set
 * Sec-Fetch-Site on every fetch from a secure context, and Origin on
 * cross-origin and non-GET ones. On plain http neither may be present, so the
 * app's custom CLIENT_HEADER is accepted as a last resort (see its comment).
 * Requests carrying none of these (curl, servers) are refused.
 */
export function isSameOrigin(request: Request) {
  const site = request.headers.get("Sec-Fetch-Site")
  if (site !== null) return site === "same-origin"
  const origin = request.headers.get("Origin")
  if (origin !== null) return origin === new URL(request.url).origin
  return request.headers.get(CLIENT_HEADER) === "1"
}

function toBase64Url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

// Without a configured secret, a random key per process: tokens die with it.
let processSecret: string | undefined
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined

function hmacKey(configured: string | undefined) {
  const secret =
    configured || (processSecret ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), String).join("."))
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    )
    cachedKey = { secret, key }
  }
  return cachedKey.key
}

function signedPayload(expires: number, ip: string) {
  return new TextEncoder().encode(`${expires}.${ip}`)
}

/** Token format: `<expiry unix seconds>.<base64url HMAC-SHA256(expiry.ip)>`. */
export async function issueProxyToken(secret: string | undefined, ip: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + PROXY_TOKEN_TTL_SECONDS
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), signedPayload(expires, ip))
  return { token: `${expires}.${toBase64Url(signature)}`, expiresAt: new Date(expires * 1000).toISOString() }
}

export async function verifyProxyToken(secret: string | undefined, token: string, ip: string, now = Date.now()) {
  const match = token.match(/^(\d{1,12})\.([A-Za-z0-9_-]{43})$/)
  if (!match) return false
  const expires = Number(match[1])
  const nowSeconds = now / 1000
  if (expires <= nowSeconds || expires > nowSeconds + PROXY_TOKEN_TTL_SECONDS + 60) return false
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64Url(match[2]), signedPayload(expires, ip))
  } catch {
    return false
  }
}
