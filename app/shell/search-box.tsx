import * as React from "react"
import {
  ArrowClockwiseIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CircleHalfIcon,
  CubeIcon,
  FileArrowDownIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  SquaresFourIcon,
  StackIcon,
  TagIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import { useNavigate } from "react-router"

import { jobPath, labelPath, logGroupPath, logLabelPath, metricPath, paths } from "@/app/paths"
import { navChords } from "@/app/shell/hotkeys"
import { useShellActions, type ShellActions } from "@/app/shell/shell-actions"
import { spring } from "@/components/motion"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { formatBytes } from "@/lib/core/bytes"
import { jobLabel } from "@/lib/core/jobs"
import { groupNoun } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot } from "@/lib/core/logs/types"
import { fetchLabelNames, type TsdbStatus } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

type Kind = "page" | "action" | "job" | "metric" | "service" | "label"

interface Result {
  kind: Kind
  /** Display name. */
  name: string
  value?: string
  /** Keys shown on the right, e.g. ["G", "M"]. */
  keys?: string[]
  icon: Icon
  to?: string
  run?: () => void
}

const GROUPS: Array<{ kind: Kind; title: string }> = [
  { kind: "page", title: "Pages" },
  { kind: "action", title: "Actions" },
  { kind: "job", title: "Jobs" },
  { kind: "metric", title: "Metrics" },
  { kind: "service", title: "Services" },
  { kind: "label", title: "Labels" },
]

/** The go-to chords as page results: the current signal's pages, shared pages, and switching signal. */
function usePages(): Result[] {
  const signal = useSignal()
  const lastPathBySignal = useAppStore((state) => state.lastPathBySignal)
  return React.useMemo(
    () =>
      Object.entries(navChords(signal, lastPathBySignal))
        .filter(([, page]) => page.signal !== signal)
        .map(([key, page]) => ({ kind: "page", name: page.label, to: page.to, keys: ["G", key.toUpperCase()], icon: SquaresFourIcon })),
    [signal, lastPathBySignal]
  )
}

function actionResults(actions: ShellActions, hasConnection: boolean): Result[] {
  return [
    ...(hasConnection ? [{ kind: "action" as const, name: "Refresh snapshot", keys: ["R"], icon: ArrowClockwiseIcon, run: actions.refresh }] : []),
    { kind: "action", name: "Start agent session", icon: RobotIcon, to: paths.agent },
    { kind: "action", name: "Export report", icon: FileArrowDownIcon, run: actions.openReport },
    { kind: "action", name: "Toggle theme", icon: CircleHalfIcon, run: actions.toggleTheme },
    { kind: "action", name: "Open glossary", icon: BookOpenIcon, run: actions.openGlossary },
    { kind: "action", name: "Keyboard shortcuts", keys: ["?"], icon: KeyboardIcon, run: actions.openShortcuts },
  ]
}

/** Label names for search: the instance's label list, with value counts where the Labels card loaded them. */
function useLabelNames(enabled: boolean) {
  const connection = useConnection()
  const key = connectionKey(connection)
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ["label-names", key],
    enabled: enabled && Boolean(connection),
    queryFn: ({ signal }) => fetchLabelNames(connection!, undefined, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })
  return React.useMemo(() => {
    const counts = new Map(
      (queryClient.getQueryData<TsdbStatus>(["tsdb-status", key])?.labelValueCountByLabelName ?? []).map((item) => [item.name, item.value])
    )
    const names = data ?? Array.from(counts.keys())
    return names.filter((name) => name !== "__name__").map((name) => ({ name, values: counts.get(name) }))
  }, [data, key, queryClient])
}

/** Logs search: the logs snapshot's groups (services) and stream labels. */
function logsResults(snapshot: LogsSnapshot | null, needle: string): Result[] {
  if (!snapshot) return []
  const matches = (text: string) => text.toLowerCase().includes(needle)
  const services: Result[] = snapshot.groups
    .filter((group) => !needle || matches(group.value))
    .slice(0, needle ? 6 : 4)
    .map((group) => ({ kind: "service", name: group.value, value: formatBytes(group.bytes), to: logGroupPath(group.value), icon: StackIcon }))
  const labels: Result[] = needle
    ? snapshot.labels
        .filter((label) => matches(label.label))
        .slice(0, 4)
        .map((label) => ({ kind: "label", name: label.label, value: `${formatNumber(label.distinctValues)} values`, to: logLabelPath(label.label), icon: TagIcon }))
    : []
  return [...services, ...labels]
}

function useResults(query: string, open: boolean): Result[] {
  const signal = useSignal()
  const logs = signal === "logs"
  const snapshot = useAppStore((state) => state.snapshot)
  const logsSnapshot = useAppStore((state) => state.logsSnapshot)
  const hasConnection = useAppStore((state) => Boolean((logs ? state.logsSettings : state.settings).baseUrl.trim()))
  const actions = useShellActions()
  const labels = useLabelNames(open && !logs)
  const pages = usePages()
  return React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (text: string) => text.toLowerCase().includes(needle)
    const allActions = actionResults(actions, hasConnection)
    if (logs) {
      const found = needle ? [...pages.filter((page) => matches(page.name)), ...allActions.filter((action) => matches(action.name))] : allActions
      return [...found, ...logsResults(logsSnapshot, needle)]
    }
    if (!needle) {
      // Before typing: the biggest jobs and metrics, and what you can do.
      const jobs: Result[] = (snapshot?.jobs ?? [])
        .slice(0, 2)
        .map((job) => ({ kind: "job", name: jobLabel(job.job), value: formatNumber(job.seriesCount), to: jobPath(job.job), icon: BriefcaseIcon }))
      const metrics: Result[] = (snapshot?.metrics ?? [])
        .slice(0, 4)
        .map((metric) => ({ kind: "metric", name: metric.metric, value: formatNumber(metric.seriesCount), to: metricPath(metric.metric), icon: CubeIcon }))
      return [...allActions, ...jobs, ...metrics]
    }
    const pageResults = pages.filter((page) => matches(page.name))
    const found = allActions.filter((action) => matches(action.name))
    const jobs: Result[] = (snapshot?.jobs ?? [])
      .filter((job) => matches(jobLabel(job.job)))
      .slice(0, 3)
      .map((job) => ({ kind: "job", name: jobLabel(job.job), value: formatNumber(job.seriesCount), to: jobPath(job.job), icon: BriefcaseIcon }))
    const metrics: Result[] = (snapshot?.metrics ?? [])
      .filter((metric) => matches(metric.metric))
      .slice(0, 6)
      .map((metric) => ({ kind: "metric", name: metric.metric, value: formatNumber(metric.seriesCount), to: metricPath(metric.metric), icon: CubeIcon }))
    const labelResults: Result[] = labels
      .filter((label) => matches(label.name))
      .slice(0, 4)
      .map((label) => ({
        kind: "label",
        name: label.name,
        value: label.values === undefined ? undefined : `${formatNumber(label.values)} values`,
        to: labelPath(label.name),
        icon: TagIcon,
      }))
    return [...pageResults, ...found, ...jobs, ...metrics, ...labelResults]
  }, [query, snapshot, logsSnapshot, logs, actions, hasConnection, labels, pages])
}

/**
 * A search icon in the header that stretches into an input when opened, with
 * results unfolding underneath. Opened by click, ⌘K or "/". Below `lg` the
 * open input overlays the whole header row.
 */
export function SearchBox({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const signal = useSignal()
  const hasSnapshot = useAppStore((state) => Boolean(signal === "logs" ? state.logsSnapshot : state.snapshot))
  const [query, setQuery] = React.useState("")
  const [cursor, setCursor] = React.useState(0)
  const results = useResults(query, open)
  const groupLabel = useAppStore((state) => state.logsSnapshot?.groupLabel)
  const serviceTitle = groupLabel ? groupNoun(groupLabel).replace(/^\w/, (c) => c.toUpperCase()) : null
  const rootRef = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  // The cursor stays inside the results; -1 when there are none.
  const active = results.length ? Math.min(Math.max(cursor, 0), results.length - 1) : -1
  const listOpen = open && results.length > 0

  const close = React.useCallback(() => {
    onOpenChange(false)
    setQuery("")
    setCursor(0)
  }, [onOpenChange])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, close])

  const go = (index: number) => {
    const result = index >= 0 ? results[index] : undefined
    if (!result) return
    close()
    if (result.to) navigate(result.to)
    result.run?.()
  }

  return (
    <div
      ref={rootRef}
      className={cn("flex justify-end", open ? "z-10 max-lg:absolute max-lg:inset-x-4 max-lg:inset-y-0 max-lg:items-center sm:max-lg:inset-x-6 lg:relative" : "relative")}
    >
      <motion.div
        layout
        transition={spring}
        style={{ borderRadius: 999 }}
        className={cn(
          "flex items-center overflow-hidden border transition-[background-color,border-color,box-shadow] duration-200",
          open ? "h-9 w-full border-frame-border bg-frame shadow-xs lg:w-[22rem]" : "size-7 border-transparent"
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {open ? (
            <motion.div
              key="input"
              className="flex w-full items-center gap-2 pr-1.5 pl-3"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.18 }}
            >
              <MagnifyingGlassIcon className="size-4 shrink-0 text-brand" />
              <input
                autoFocus
                type="text"
                role="combobox"
                aria-label="Search metrics, jobs, labels, pages and actions"
                aria-autocomplete="list"
                aria-expanded={listOpen}
                aria-controls={listId}
                aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCursor(0)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") close()
                  else if (event.key === "ArrowDown") {
                    event.preventDefault()
                    setCursor(Math.max(0, Math.min(results.length - 1, active + 1)))
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault()
                    setCursor(Math.max(0, active - 1))
                  } else if (event.key === "Enter") {
                    event.preventDefault()
                    go(active)
                  }
                }}
                placeholder={
                  hasSnapshot ? (signal === "logs" ? "Search services, labels, pages…" : "Search metrics, jobs, labels, pages…") : "Search pages and actions…"
                }
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                aria-label="Close search"
                onClick={close}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-well hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="button"
              className="size-full"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.18 }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Search"
                    aria-keyshortcuts="Meta+K /"
                    onClick={() => onOpenChange(true)}
                    className="group/search flex size-full items-center justify-center rounded-full text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 dark:hover:bg-muted/50 focus-visible:ring-ring/50"
                  >
                    <MagnifyingGlassIcon className="size-4 group-hover/search:animate-wiggle" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Search
                  <KbdGroup aria-hidden>
                    <Kbd>⌘K</Kbd>
                  </KbdGroup>
                </TooltipContent>
              </Tooltip>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {open && (results.length > 0 || query) ? (
          <motion.div
            className="absolute top-full right-0 z-50 mt-2 w-full origin-top-right lg:w-[26rem] overflow-hidden rounded-[22px] border border-frame-border bg-popover p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_16px_40px_rgba(0,0,0,0.12)] [corner-shape:squircle]"
            initial={{ opacity: 0, y: -6, scale: 0.97, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, scale: 0.97, filter: "blur(4px)" }}
            transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
          >
            {results.length ? (
              <div id={listId} role="listbox" aria-label="Search results" className="flex max-h-[min(28rem,70svh)] flex-col gap-1 overflow-y-auto">
                {GROUPS.map((group) => {
                  const items = results.map((result, index) => ({ result, index })).filter(({ result }) => result.kind === group.kind)
                  if (!items.length) return null
                  const headingId = `${listId}-${group.kind}`
                  return (
                    <div key={group.kind} role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
                      <div id={headingId} role="presentation" className="px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">
                        {group.kind === "service" && serviceTitle ? serviceTitle : group.title}
                      </div>
                      {items.map(({ result, index }) => (
                        <motion.div
                          key={`${result.kind}-${result.name}-${result.to ?? ""}`}
                          id={optionId(index)}
                          role="option"
                          aria-selected={index === active}
                          initial={{ opacity: 0, filter: "blur(3px)" }}
                          animate={{ opacity: 1, filter: "blur(0px)" }}
                          transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.02 }}
                          onPointerEnter={() => setCursor(index)}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => go(index)}
                          className="relative flex min-w-0 cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm"
                        >
                          {index === active ? (
                            <motion.span layoutId="search-cursor" transition={spring} className="absolute inset-0 rounded-2xl bg-well" />
                          ) : null}
                          <result.icon className="relative size-4 shrink-0 text-muted-foreground" />
                          <span className={cn("relative min-w-0 flex-1 truncate", (result.kind === "metric" || result.kind === "label") && "font-mono text-xs")}>
                            {result.name}
                          </span>
                          {result.value ? <span className="relative shrink-0 text-xs text-muted-foreground tabular-nums">{result.value}</span> : null}
                          {result.keys ? (
                            <KbdGroup className="relative hidden shrink-0 sm:inline-flex">
                              {result.keys.map((key, keyIndex) => (
                                <Kbd key={`${keyIndex}-${key}`}>{key}</Kbd>
                              ))}
                            </KbdGroup>
                          ) : null}
                        </motion.div>
                      ))}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                Nothing matches “{query}”.
              </p>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
