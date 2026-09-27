import { paths } from "@/app/paths"
import { signalEntry, type Signal } from "@/lib/core/signals"

const OVERLAY_SELECTOR = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox]"

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[contenteditable=true]") !== null)
  )
}

function overlayOpen(target: EventTarget | null) {
  if (target instanceof Element && target.closest(OVERLAY_SELECTOR)) return true
  return document.querySelector("[role=dialog][data-state=open],[role=alertdialog][data-state=open]") !== null
}

/** True for ⌘K / Ctrl+K, the one shortcut that works while typing. */
export function isSearchShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k"
}

/**
 * Whether a global single-key shortcut should ignore this event: repeats,
 * modifiers, typing, and anything inside or behind a dialog, menu or listbox.
 */
export function ignoreShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return true
  if (overlayOpen(event.target)) return true
  if (isSearchShortcut(event)) return false
  return event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)
}

export interface NavChord {
  to: string
  label: string
  /** Switches signal instead of opening a page. */
  signal?: Signal
}

const SIGNAL_CHORDS: Record<Signal, Record<string, NavChord>> = {
  metrics: {
    o: { to: paths.overview, label: "Overview" },
    e: { to: paths.explore, label: "Explore" },
    j: { to: paths.jobs, label: "Jobs" },
    c: { to: paths.churn, label: "Churn" },
    h: { to: paths.histograms, label: "Histograms" },
  },
  logs: {
    o: { to: paths.logs, label: "Overview" },
    e: { to: paths.logStreams, label: "Streams" },
    b: { to: paths.logLabels, label: "Labels" },
    v: { to: paths.logVolume, label: "Volume" },
    p: { to: paths.logPatterns, label: "Patterns" },
  },
}

/**
 * `g` then a letter: the current signal's pages, the shared pages, and `m` /
 * `l` to switch signal (landing on that signal's last page).
 */
export function navChords(signal: Signal, lastPathBySignal: Partial<Record<Signal, string>> = {}): Record<string, NavChord> {
  return {
    ...SIGNAL_CHORDS[signal],
    r: { to: paths.rules, label: "Rules" },
    a: { to: paths.recommendations, label: "Recommendations" },
    t: { to: paths.attribution, label: "Attribution" },
    g: { to: paths.agent, label: "Agent" },
    s: { to: paths.settings, label: "Settings" },
    m: { to: signalEntry("metrics", lastPathBySignal), label: "Switch to Metrics", signal: "metrics" },
    l: { to: signalEntry("logs", lastPathBySignal), label: "Switch to Logs", signal: "logs" },
  }
}

export interface ShortcutGroup {
  title: string
  items: Array<{ keys: string[][]; label: string }>
}

/** Every shortcut, as the help overlay lists them, with the go-to chords for `signal`. Each entry of `keys` is one alternative. */
export function shortcutGroups(signal: Signal): ShortcutGroup[] {
  return SHORTCUT_GROUPS.map((group) => {
    if (group.title === "Go to") return { ...group, items: Object.entries(navChords(signal)).map(([key, { label }]) => ({ keys: [["G", key.toUpperCase()]], label })) }
    if (signal !== "logs") return group
    if (group.title === "General") {
      return { ...group, items: group.items.map((item) => (item.keys[0]?.[1] === "K" ? { ...item, label: "Search services, labels, pages and actions" } : item)) }
    }
    return {
      title: "Tables (Streams, Labels)",
      items: group.items.map((item) =>
        item.keys[0]?.[0] === "X" ? { ...item, label: "Drop the highlighted stream group, or move the highlighted label to metadata" } : item.keys[0]?.[0] === "Enter" ? { ...item, label: "Open the row" } : item
      ),
    }
  })
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: [["⌘", "K"], ["/"]], label: "Search metrics, jobs, pages and actions" },
      { keys: [["R"]], label: "Refresh the snapshot" },
      { keys: [["?"]], label: "Show keyboard shortcuts" },
      { keys: [["Esc"]], label: "Close search or dialog" },
    ],
  },
  {
    title: "Go to",
    items: [],
  },
  {
    title: "Tables (Explore, Jobs, a job's metrics)",
    items: [
      { keys: [["J"]], label: "Next row" },
      { keys: [["K"]], label: "Previous row" },
      { keys: [["Enter"]], label: "Open the row, or expand a histogram family" },
      { keys: [["X"]], label: "Drop or keep the highlighted metric" },
    ],
  },
]
