import * as React from "react"
import { AnimatePresence, MotionConfig, motion } from "motion/react"
import { useTheme } from "next-themes"
import { useLocation, useNavigate, useOutlet } from "react-router"

import { ActivitySheet } from "@/app/shell/activity-sheet"
import { ConnectGrafanaDialog } from "@/features/grafana/connect-grafana-dialog"
import { ExportDashboardDialog } from "@/features/grafana/export-dashboard-dialog"
import { Footer } from "@/app/shell/footer"
import { GlossarySheet } from "@/app/shell/glossary-sheet"
import { ignoreShortcut, isSearchShortcut, navChords } from "@/app/shell/hotkeys"
import { ReportDialog } from "@/app/shell/report-dialog"
import { ShellActionsContext, type ShellActions } from "@/app/shell/shell-actions"
import { ShortcutsDialog } from "@/app/shell/shortcuts-dialog"
import { TokenBanner } from "@/app/shell/token-banner"
import { TopBar } from "@/app/shell/top-bar"
import { Kbd } from "@/components/ui/kbd"
import { useBackendDetection, useRefreshSignalSnapshot } from "@/hooks/use-cardinality"
import { useAgentBridge } from "@/hooks/use-agent-bridge"
import { useLogRuleImpacts } from "@/hooks/use-log-rule-impacts"
import { useRuleImpacts } from "@/hooks/use-rule-impacts"
import { useSignal, useTrackSignal } from "@/hooks/use-signal"
import { useAppStore } from "@/lib/store/app-store"

/** Holds on to the page it first rendered, so an exiting page keeps its content. */
function FrozenOutlet() {
  const outlet = useOutlet()
  const [frozen] = React.useState(outlet)
  return frozen
}

function AnimatedOutlet() {
  const { pathname } = useLocation()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, filter: "blur(4px)", y: 6 }}
        animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
        exit={{ opacity: 0, filter: "blur(4px)", y: -4 }}
        transition={{ duration: 0.22, ease: "easeInOut" }}
      >
        <FrozenOutlet />
      </motion.div>
    </AnimatePresence>
  )
}

/** How long `g` waits for the second key. */
const CHORD_TIMEOUT = 1500

/** The transient "g…" hint while a go-to chord waits for its second key. */
function ChordHint({ show, keys }: { show: boolean; keys: string[] }) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="chord"
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-frame-border bg-popover px-3 py-1.5 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.12)]"
          initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          transition={{ duration: 0.18 }}
        >
          <Kbd>G</Kbd>
          <span className="text-muted-foreground">…then</span>
          <span className="flex gap-1">
            {keys.map((key) => (
              <Kbd key={key}>{key.toUpperCase()}</Kbd>
            ))}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function AppShell() {
  // Background work that must live as long as the tab: the agent relay and
  // exact-impact measurement for rules.
  useAgentBridge()
  useRuleImpacts()
  useLogRuleImpacts()
  useBackendDetection()
  useTrackSignal()

  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [activityOpen, setActivityOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [glossaryOpen, setGlossaryOpen] = React.useState(false)
  const [reportOpen, setReportOpen] = React.useState(false)
  const [grafanaConnectOpen, setGrafanaConnectOpen] = React.useState(false)
  const [grafanaExportOpen, setGrafanaExportOpen] = React.useState(false)
  const [chord, setChord] = React.useState(false)
  const chordRef = React.useRef(false)
  const signal = useSignal()
  // R and "Refresh snapshot" refresh the signal in view.
  const { refresh } = useRefreshSignalSnapshot(signal)
  const lastPathBySignal = useAppStore((state) => state.lastPathBySignal)
  const chords = React.useMemo(() => navChords(signal, lastPathBySignal), [signal, lastPathBySignal])
  const chordsRef = React.useRef(chords)
  React.useEffect(() => {
    chordsRef.current = chords
  }, [chords])

  const actions = React.useMemo<ShellActions>(
    () => ({
      refresh,
      toggleTheme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      openShortcuts: () => setShortcutsOpen(true),
      openGlossary: () => setGlossaryOpen(true),
      openReport: () => setReportOpen(true),
      openActivity: () => setActivityOpen(true),
      openGrafanaConnect: () => setGrafanaConnectOpen(true),
      openGrafanaExport: () => setGrafanaExportOpen(true),
    }),
    [refresh, resolvedTheme, setTheme]
  )

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const endChord = () => {
      clearTimeout(timer)
      chordRef.current = false
      setChord(false)
    }
    // Capture phase, so a consumed key is marked handled before table shortcuts see it.
    const onKey = (event: KeyboardEvent) => {
      if (ignoreShortcut(event)) {
        if (chordRef.current && !event.repeat) endChord()
        return
      }
      if (chordRef.current) {
        const target = chordsRef.current[event.key.toLowerCase()]
        endChord()
        if (target && !event.shiftKey) {
          event.preventDefault()
          navigate(target.to)
        }
        return
      }
      if (isSearchShortcut(event)) {
        event.preventDefault()
        setSearchOpen((open) => !open)
      } else if (event.key === "/") {
        event.preventDefault()
        setSearchOpen(true)
      } else if (event.key === "?") {
        event.preventDefault()
        setShortcutsOpen(true)
      } else if (event.key === "g" && !event.shiftKey) {
        event.preventDefault()
        chordRef.current = true
        setChord(true)
        clearTimeout(timer)
        timer = setTimeout(endChord, CHORD_TIMEOUT)
      } else if (event.key === "r" && !event.shiftKey) {
        refresh()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      clearTimeout(timer)
    }
  }, [refresh, navigate])

  return (
    <ShellActionsContext.Provider value={actions}>
      <MotionConfig reducedMotion="user">
        <div className="relative flex min-h-svh flex-col bg-background">
          <TopBar searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-32 pb-16 sm:px-6">
            <TokenBanner />
            <AnimatedOutlet />
          </main>
          <Footer />
          <ActivitySheet open={activityOpen} onOpenChange={setActivityOpen} />
          <GlossarySheet open={glossaryOpen} onOpenChange={setGlossaryOpen} />
          <ReportDialog open={reportOpen} onOpenChange={setReportOpen} />
          <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <ConnectGrafanaDialog open={grafanaConnectOpen} onOpenChange={setGrafanaConnectOpen} />
          <ExportDashboardDialog open={grafanaExportOpen} onOpenChange={setGrafanaExportOpen} />
          <ChordHint show={chord} keys={Object.keys(chords)} />
        </div>
      </MotionConfig>
    </ShellActionsContext.Provider>
  )
}
