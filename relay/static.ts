// Serves the built app (dist/client) from a path → Blob map: embedded in the
// compiled binary, or read from disk when running from source.

export type Assets = ReadonlyMap<string, Blob>

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
}

/** Files in dist/client that are Cloudflare config, not part of the app. */
export const SKIPPED_ASSETS = new Set(["/_headers", "/_redirects", "/.assetsignore", "/wrangler.json", "/.dev.vars"])

export function contentType(path: string) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
}

/**
 * GET and HEAD for the app: exact files first, then index.html for routes
 * (paths without an extension), 404 for missing files.
 */
export function serveStatic(request: Request, assets: Assets): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
  }
  let path: string
  try {
    path = decodeURIComponent(new URL(request.url).pathname)
  } catch {
    return new Response("Bad request", { status: 400 })
  }
  if (path.endsWith("/")) path += "index.html"

  const skipped = SKIPPED_ASSETS.has(path)
  let file = skipped ? undefined : assets.get(path)
  let spa = false
  if (!file && !skipped && !/\.[a-z0-9]+$/i.test(path)) {
    file = assets.get("/index.html")
    spa = true
  }
  if (!file) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } })

  const servedPath = spa ? "/index.html" : path
  const headers = new Headers({
    "Content-Type": contentType(servedPath),
    "Content-Length": String(file.size),
    // Vite hashes everything under /assets/; everything else may change between versions.
    "Cache-Control": servedPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  })
  return new Response(request.method === "HEAD" ? null : file, { status: 200, headers })
}
