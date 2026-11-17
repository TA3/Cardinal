import { execFileSync } from "node:child_process"
import path from "node:path"

import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import packageJson from "./package.json"

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

function git(...args: string[]) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  } catch {
    return ""
  }
}

/**
 * The version shown in the app's footer: CARDINAL_VERSION (release builds and
 * the Docker image), the tag a GitHub Actions run builds, else `git describe`
 * (e.g. 0.6.0-3-gabc1234 a few commits after v0.6.0). Clones without tags
 * (Cloudflare Workers Builds) get package.json's version and the commit.
 */
function appVersion() {
  const given = process.env.CARDINAL_VERSION || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
  if (given) return given.replace(/^v/, "")
  const described = git("describe", "--tags", "--match", "v*")
  if (described) return described.replace(/^v/, "")
  const commit = (process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse", "HEAD")).slice(0, 7)
  return commit ? `${packageJson.version}+${commit}` : packageJson.version
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
