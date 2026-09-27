// Request guards shared by the proxy and the session endpoints.
//
// Honest scope: these checks raise the bar for using Cardinal's Worker as a
// general-purpose relay from other sites or scripts, but they are not a hard
// guarantee. Anyone can load Cardinal itself, mint a proxy token from their own
// IP and replay it with a non-browser client until it expires. What they buy is
// that drive-by cross-site use fails, tokens are bound to one client IP and die
// within minutes, and every IP is rate-limited.

import { CLIENT_HEADER } from "../lib/sources/proxy-constants"

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

export function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown"
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

// WARNING: without PROXY_SECRET each isolate invents its own key, so a token
// minted by one isolate fails on another. The client refreshes on 401, which
// papers over it in dev, but production deployments should set the secret
// (`wrangler secret put PROXY_SECRET`, or PROXY_SECRET=... in .dev.vars).
let isolateSecret: string | undefined
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined

function hmacKey(configured: string | undefined) {
  const secret =
    configured || (isolateSecret ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), String).join("."))
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
