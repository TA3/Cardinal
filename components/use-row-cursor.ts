import * as React from "react"

import { ignoreShortcut } from "@/app/shell/hotkeys"

/** Enter on a focused link or button belongs to that control. */
function onControl(target: EventTarget | null) {
  return target instanceof Element && target.closest("a,button,[role=button],[role=radio]") !== null
}

/**
 * Keyboard row cursor for a table: `j` / `k` move a highlighted row (scrolled
 * into view), Enter opens it and `x` runs the row's toggle. Uses the shell's
 * hotkey guard, so nothing fires while typing or with a dialog open. The
 * cursor starts hidden and resets when `resetKey` changes.
 */
export function useRowCursor({
  count,
  resetKey,
  onOpen,
  onToggle,
  enabled = true,
}: {
  count: number
  resetKey?: string
  onOpen: (index: number) => void
  onToggle?: (index: number) => void
  enabled?: boolean
}) {
  const [state, setState] = React.useState({ key: resetKey, cursor: -1 })
  const cursor = state.key === resetKey ? Math.min(state.cursor, count - 1) : -1
  const rows = React.useRef(new Map<number, HTMLElement>())
  // Latest values for the listener, which is registered once.
  const latest = React.useRef({ cursor, count, onOpen, onToggle })
  React.useLayoutEffect(() => {
    latest.current = { cursor, count, onOpen, onToggle }
  })

  const moveTo = React.useCallback(
    (next: number) => {
      setState({ key: resetKey, cursor: next })
      requestAnimationFrame(() => rows.current.get(next)?.scrollIntoView({ block: "nearest" }))
    },
    [resetKey]
  )

  React.useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (ignoreShortcut(event) || event.shiftKey) return
      const { cursor: current, count: total, onOpen: open, onToggle: toggle } = latest.current
      if (!total) return
      if (event.key === "j") {
        event.preventDefault()
        moveTo(Math.min(total - 1, current + 1))
      } else if (event.key === "k") {
        event.preventDefault()
        moveTo(Math.max(0, current - 1))
      } else if (event.key === "Enter" && current >= 0 && !onControl(event.target)) {
        event.preventDefault()
        open(current)
      } else if (event.key === "x" && current >= 0 && toggle) {
        event.preventDefault()
        toggle(current)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [enabled, moveTo])

  /** Props for row `index`: highlight state and the ref used to scroll it into view. */
  const rowProps = React.useCallback(
    (index: number) => ({
      "data-cursor": index === cursor ? ("true" as const) : undefined,
      ref: (element: HTMLElement | null) => {
        if (element) rows.current.set(index, element)
        else rows.current.delete(index)
      },
    }),
    [cursor]
  )

  return { cursor, rowProps, setCursor: moveTo }
}

/** Classes for a row under the keyboard cursor. */
export const CURSOR_ROW_CLASS =
  "scroll-mt-44 scroll-mb-6 data-[cursor=true]:bg-well data-[cursor=true]:shadow-[inset_2px_0_0_var(--brand)]"
