import "@fontsource-variable/geist-mono"
import "./globals.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "react-router"

import { router } from "@/app/router"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isAuthError } from "@/hooks/use-cardinality"
import { detectServer } from "@/features/relay/detect"
import { useAppStore } from "@/lib/store/app-store"

// A 401 anywhere means the token is missing or wrong; the shell then asks for it.
// Logs queries and mutations carry meta.signal = "logs" and mark that connection instead.
function trackAuth(error: unknown, meta?: Record<string, unknown>) {
  if (!isAuthError(error)) return
  if (meta?.signal === "logs") useAppStore.getState().setLogsAuthError(true)
  else useAppStore.getState().setAuthError(true)
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => trackAuth(error, query.meta) }),
  mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => trackAuth(error, mutation.meta) }),
  defaultOptions: {
    // Pages share queries (Streams, a group, Patterns…): keep results for half an hour so moving between them reads the cache.
    queries: { staleTime: 60_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)

void detectServer()
