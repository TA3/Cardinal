export { isSameOrigin } from "@/lib/proxy/guard"

/** The caller's IP, as Cloudflare reports it. */
export function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown"
}
