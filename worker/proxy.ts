import { forwardProxyRequest, isAllowedPath, proxyError } from "@/lib/proxy/core"
import { isPrivateHost, PROXY_TOKEN_HEADER } from "@/lib/sources/proxy-constants"
import { clientIp, isSameOrigin, verifyProxyToken } from "./guard"

export { isAllowedPath, isPrivateHost }

// Credential pass-through proxy for backends that do not send CORS headers
// (Grafana Cloud included). Nothing is stored or logged. Which paths are
// reachable lives in lib/proxy/core.ts, shared with the self-hosted server;
// the hosted Worker additionally refuses private hosts. Callers must be
// same-origin and hold a fresh proxy token (see guard.ts for what that does
// and does not guarantee).

export async function handleProxy(request: Request, secret: string | undefined): Promise<Response> {
  if (!isSameOrigin(request)) return proxyError(403, "Cross-origin proxy use is not allowed")
  const token = request.headers.get(PROXY_TOKEN_HEADER) ?? ""
  if (!(await verifyProxyToken(secret, token, clientIp(request)))) {
    return proxyError(401, "Missing or expired proxy token", "token")
  }
  return forwardProxyRequest(request, { blockPrivate: true })
}
