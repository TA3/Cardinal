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

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
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
