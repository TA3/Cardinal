import * as React from "react"
import {
  BookOpenIcon,
  DotsThreeVerticalIcon,
  ExportIcon,
  FileArrowDownIcon,
  GearIcon,
  KeyboardIcon,
  LockSimpleIcon,
  MoonIcon,
  SquaresFourIcon,
  SunIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react"
import { AnimatePresence, motion } from "motion/react"
import { useTheme } from "next-themes"
import { Link, useLocation } from "react-router"

import { paths } from "@/app/paths"
import { NavBar } from "@/app/shell/nav-bar"
import { SearchBox } from "@/app/shell/search-box"
import { useShellActions } from "@/app/shell/shell-actions"
import { Logo } from "@/components/logo"
import { useCost } from "@/components/cost-text"
import { LiveDot, SwapText } from "@/components/motion"
import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConnection, useNeedsTokenFor, useRuleCounts, useSavings } from "@/hooks/use-cardinality"
import { useSignal, useSwitchSignal } from "@/hooks/use-signal"
import { SIGNALS, SIGNAL_LABEL, signalHome } from "@/lib/core/signals"
import { cn } from "@/lib/utils"

/** Stacked backdrop blurs that fade out downwards, so content dissolves under the bar. */
function ProgressiveBlur() {
  const layers = [
    ["backdrop-blur-[2px]", "black 55%, transparent 84%"],
    ["backdrop-blur-[6px]", "black 42%, transparent 70%"],
    ["backdrop-blur-[14px]", "black 28%, transparent 56%"],
    ["backdrop-blur-[28px]", "black 12%, transparent 42%"],
  ] as const
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-36">
      {layers.map(([blur, mask]) => (
        <div key={blur} className={cn("absolute inset-0", blur)} style={{ maskImage: `linear-gradient(to bottom, ${mask})` }} />
      ))}
    </div>
  )
}

function SavingsPill({ hidden }: { hidden: boolean }) {
  const savings = useSavings()
  const counts = useRuleCounts()
  const cost = useCost().format(savings.savedSeries)
  // Ten bars, one per 5% of series removed.
  const filled = savings.percent > 0 ? Math.max(1, Math.min(10, Math.ceil(savings.percent / 5))) : 0
  // Only once there are rules; before that the pill would just say 0%.
  const show = counts.active + counts.proposed > 0 && !hidden
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="savings"
          className="hidden lg:block"
          initial={{ opacity: 0, filter: "blur(4px)", scale: 0.9 }}
          animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
          exit={{ opacity: 0, filter: "blur(4px)", scale: 0.9 }}
          transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
        >
          <Link
            to={paths.rules}
            aria-label={`Rules: ${counts.proposed ? `${counts.proposed} proposed` : `${savings.percent.toFixed(1)}% of series saved`}${cost ? `, ${cost} saved` : ""}`}
            className="flex h-8 items-center gap-2.5 rounded-full border border-frame-border bg-frame px-3 text-sm shadow-xs transition-colors outline-none hover:bg-well focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Rules
            <span aria-hidden className="flex items-center gap-[2.5px]">
              {Array.from({ length: 10 }, (_, index) => (
                <span
                  key={index}
                  className={cn("h-3 w-[2.5px] rounded-full transition-colors duration-500", index < filled ? "bg-brand" : "bg-border")}
                  style={{ transitionDelay: `${index * 30}ms` }}
                />
              ))}
            </span>
            <span className="text-muted-foreground tabular-nums">
              <SwapText value={counts.proposed ? `${counts.proposed} new` : `${savings.percent.toFixed(1)}%`} />
            </span>
            {cost && savings.savedSeries > 0 ? (
              <span aria-hidden className="hidden text-xs text-muted-foreground tabular-nums lg:inline">
                <SwapText value={cost} />
              </span>
            ) : null}
          </Link>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** Metrics | Logs, with the tab bar's sliding pill. Switching opens that signal's last page. */
function SignalSwitch() {
  const signal = useSignal()
  const switchSignal = useSwitchSignal()
  return (
    <SegmentedControl
      aria-label="Signal"
      value={signal}
      onValueChange={switchSignal}
      options={SIGNALS.map((value) => ({ value, label: SIGNAL_LABEL[value], title: `${SIGNAL_LABEL[value]} (G then ${value[0].toUpperCase()})` }))}
    />
  )
}

function ConnectionPill() {
  const signal = useSignal()
  const connection = useConnection(signal)
  const locked = useNeedsTokenFor(signal)
  const empty = signal === "logs" ? "No logs source" : "No data source"
  const host = React.useMemo(() => {
    if (!connection) return null
    try {
      return new URL(connection.baseUrl).host
    } catch {
      return connection.baseUrl
    }
  }, [connection])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={signal === "logs" ? `${paths.settings}#logs-connection` : paths.settings}
          aria-label={host ? `${host}${locked ? " (token needed)" : ""}` : empty}
          className={cn(
            "inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full border bg-background px-2 text-xs font-medium transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-2.5",
            !host ? "text-muted-foreground" : locked ? "border-amber-500/40 text-amber-700 dark:text-amber-400" : "border-brand/30 text-brand-ink"
          )}
        >
          {!host ? (
            <LiveDot pulse={false} className="size-1.5 text-muted-foreground/50" />
          ) : locked ? (
            <LockSimpleIcon aria-hidden className="size-3" />
          ) : (
            <LiveDot className="size-1.5" />
          )}
          {/* Phones show just the status dot; the host is in the tooltip and label. */}
          <span aria-hidden className="hidden max-w-48 truncate sm:inline">
            {host ?? empty}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {host
          ? locked
            ? `${host}: token needed. Open settings to enter it.`
            : `${host}: connected. ${signal === "logs" ? "Logs source" : "Data source"} settings`
          : signal === "logs"
            ? "Connect a Loki logs source"
            : "Connect a data source"}
      </TooltipContent>
    </Tooltip>
  )
}

export function TopBar({
  searchOpen,
  onSearchOpenChange,
}: {
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
}) {
  const { resolvedTheme } = useTheme()
  const actions = useShellActions()
  const signal = useSignal()
  const { pathname } = useLocation()
  const onSettings = pathname === paths.settings
  // Below lg an open search covers the header row: fade out what it covers.
  const covered = cn("transition-[opacity,filter,visibility] duration-200", searchOpen && "max-lg:invisible max-lg:opacity-0 max-lg:blur-[2px]")

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <ProgressiveBlur />
      <div className="relative mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <div className={cn("flex min-w-0 items-center gap-2", covered)}>
          <Link
            to={signalHome(signal)}
            aria-label="Cardinal"
            className="shrink-0 rounded-full p-1 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Logo />
          </Link>
          <div className="shrink-0">
            <SignalSwitch />
          </div>
          <ConnectionPill />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SavingsPill hidden={searchOpen} />
          <SearchBox open={searchOpen} onOpenChange={onSearchOpenChange} />
          <div className={cn("flex items-center gap-1", covered)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={actions.toggleTheme}>
                  {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{resolvedTheme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant={onSettings ? "inverse" : "ghost"} size="icon-sm">
                  <Link to={paths.settings} aria-label="Settings" aria-current={onSettings ? "page" : undefined}>
                    <GearIcon weight={onSettings ? "fill" : "regular"} />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Settings
                <KbdGroup aria-hidden>
                  <Kbd>G</Kbd>
                  <Kbd>S</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="Menu">
                      <DotsThreeVerticalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">
                  Report, Grafana, glossary and shortcuts
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={actions.openReport}>
                    <FileArrowDownIcon />
                    Export report
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={actions.openGrafanaExport}>
                    <ExportIcon />
                    Export Grafana dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={actions.openGrafanaConnect}>
                    <SquaresFourIcon />
                    Connect Grafana
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={actions.openGlossary}>
                    <BookOpenIcon />
                    Glossary
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={actions.openShortcuts}>
                    <KeyboardIcon />
                    Keyboard shortcuts
                    <DropdownMenuShortcut>?</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={actions.openActivity}>
                    <TerminalWindowIcon />
                    Activity log
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <NavBar />
    </header>
  )
}
