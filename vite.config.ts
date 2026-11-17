import { execFileSync } from "node:child_process"
import path from "node:path"

import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Long-lived vendor chunks for the client, so an app deploy doesn't bust the
// libraries' cache. Earlier groups win; anything unmatched stays with its importer.
const VENDOR_GROUPS: [name: string, test: RegExp][] = [
  ["react", /node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ["router", /node_modules[\\/](react-router|cookie|set-cookie-parser)[\\/]/],
  ["motion", /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/],
  ["radix", /node_modules[\\/](@radix-ui|radix-ui|@floating-ui|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|tslib)[\\/]/],
  ["data", /node_modules[\\/](@tanstack|zustand)[\\/]/],
  ["zod", /node_modules[\\/]zod[\\/]/],
  ["yaml", /node_modules[\\/]yaml[\\/]/],
]

/**
 * The version shown in the app's footer: CARDINAL_VERSION (release builds and
 * the Docker image), the tag a GitHub Actions run builds, else `git describe`
 * (e.g. 0.6.0-3-gabc1234 a few commits after v0.6.0), else "dev".
 */
function appVersion() {
  const given = process.env.CARDINAL_VERSION || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
  if (given) return given.replace(/^v/, "")
  try {
    return execFileSync("git", ["describe", "--tags", "--match", "v*"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .replace(/^v/, "")
  } catch {
    return "dev"
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  define: { __CARDINAL_VERSION__: JSON.stringify(appVersion()) },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: VENDOR_GROUPS.map(([name, test]) => ({ name: `vendor-${name}`, test })),
            },
          },
        },
      },
    },
  },
})
