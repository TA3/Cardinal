import * as React from "react"
import { ArrowClockwiseIcon, CompassIcon, WarningIcon } from "@phosphor-icons/react"
import { isRouteErrorResponse, Link, useRouteError } from "react-router"

import { paths } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** A page chunk from an older deploy that no longer exists on the server. */
function isStaleChunk(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|Loading (CSS )?chunk|Unable to preload CSS/i.test(message)
}

function describe(error: unknown) {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`.trim()
  if (error instanceof Error) return error.message
  return String(error)
}

/** Shown when a page fails to load or render. `fullPage` when the shell itself is gone. */
export function RouteError({ fullPage = false }: { fullPage?: boolean }) {
  const error = useRouteError()
  const stale = isStaleChunk(error)
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound fullPage={fullPage} />

  return (
    <div className={cn(fullPage && "flex min-h-svh items-center justify-center bg-background p-4 [&>*]:w-full [&>*]:max-w-xl")}>
      <EmptyState
        framed
        icon={WarningIcon}
        title={stale ? "Cardinal was updated" : "Something went wrong"}
        description={
          stale
            ? "This page belongs to a newer version than the one loaded in this tab. Reload to get it; your rules are kept."
            : "This page hit an error. Reloading usually fixes it; your rules and settings are kept."
        }
      >
        <div className="flex flex-col items-center gap-2.5">
          <div className="flex gap-2">
            <Button onClick={() => window.location.reload()}>
              <ArrowClockwiseIcon data-icon="inline-start" />
              Reload
            </Button>
            <Button asChild variant="outline">
              <a href="/">Overview</a>
            </Button>
          </div>
          {stale ? null : (
            <details className="max-w-md text-left text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{describe(error)}</pre>
            </details>
          )}
        </div>
      </EmptyState>
    </div>
  )
}

/** Unknown routes still answer 200 (it's a single-page app), so keep them out of search indexes. */
function useNoIndex() {
  React.useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "robots"
    meta.content = "noindex"
    document.head.append(meta)
    return () => meta.remove()
  }, [])
}

export function NotFound({ fullPage = false }: { fullPage?: boolean }) {
  useNoIndex()
  return (
    <div className={cn(fullPage && "flex min-h-svh items-center justify-center bg-background p-4 [&>*]:w-full [&>*]:max-w-xl")}>
      <EmptyState
        framed
        icon={CompassIcon}
        title="Page not found"
        description="There's nothing at this address. It may have moved, or the link is incomplete."
      >
        <div className="flex gap-2">
          <Button asChild>
            <Link to="/">Go to Overview</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={paths.explore}>Browse metrics</Link>
          </Button>
        </div>
      </EmptyState>
    </div>
  )
}
