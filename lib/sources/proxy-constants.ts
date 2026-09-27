export const PROXY_PREFIX = "/api/proxy"
export const PROXY_TARGET_HEADER = "X-Cardinal-Target"
/** Short-lived token from PROXY_TOKEN_PATH, required on every proxied request. */
export const PROXY_TOKEN_HEADER = "X-Cardinal-Proxy-Token"
export const PROXY_TOKEN_PATH = "/api/proxy-token"
/** Set on the proxy's own 401 so the client can tell it apart from an upstream 401. */
export const PROXY_ERROR_HEADER = "X-Cardinal-Proxy-Error"
/**
 * Sent by the app on every call to its own Worker. Browsers omit Sec-Fetch-Site
 * on plain-http origins (a LAN dev server), and same-origin GETs carry no
 * Origin, so this custom header is the fallback proof of a same-origin caller:
 * a page on another origin can't add it without a CORS preflight, which the
 * Worker never approves.
 */
export const CLIENT_HEADER = "X-Cardinal-Client"

/**
 * Hosts the proxy refuses to reach (loopback, private ranges, *.local, *.internal).
 * Shared with the UI so it can tell users to use direct mode for these.
 */
export function isPrivateHost(hostname: string) {
  // "localhost." and "metadata.google.internal." resolve like their dotless forms.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true
  }
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  // Any IPv6 literal: loopback, link-local, ULA and mapped addresses are all
  // private; public v6 literals are rare enough to not support.
  return host.includes(":")
}
