import * as React from "react"
import {
  ArrowsClockwiseIcon,
  BriefcaseIcon,
  ChartBarHorizontalIcon,
  ChartBarIcon,
  FingerprintIcon,
  HardDrivesIcon,
  ListBulletsIcon,
  RobotIcon,
  ShieldCheckIcon,
  TagIcon,
  TagSimpleIcon,
  WavesIcon,
  type Icon,
} from "@phosphor-icons/react"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { Link, useLocation } from "react-router"

import { paths } from "@/app/paths"
import { navChords } from "@/app/shell/hotkeys"
import { LiveDot, SwapText, spring } from "@/components/motion"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRuleCounts } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { SIGNAL_LABEL, type Signal } from "@/lib/core/signals"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

interface Tab {
  to: string
  label: string
  icon: Icon
  /** Active only on this exact path (a signal's overview). */
  exact?: boolean
}

// What you look at, per signal; then what you do about it, shared by every signal.
const SIGNAL_TABS: Record<Signal, Tab[]> = {
  metrics: [
    { to: paths.overview, label: "Overview", icon: ChartBarIcon, exact: true },
    { to: paths.explore, label: "Explore", icon: ListBulletsIcon },
    { to: paths.jobs, label: "Jobs", icon: BriefcaseIcon },
    { to: paths.churn, label: "Churn", icon: ArrowsClockwiseIcon },
    { to: paths.histograms, label: "Histograms", icon: ChartBarHorizontalIcon },
  ],
  logs: [
    { to: paths.logs, label: "Overview", icon: ChartBarIcon, exact: true },
    { to: paths.logStreams, label: "Streams", icon: WavesIcon },
    { to: paths.logLabels, label: "Labels", icon: TagSimpleIcon },
    { to: paths.logVolume, label: "Volume", icon: HardDrivesIcon },
    { to: paths.logPatterns, label: "Patterns", icon: FingerprintIcon },
  ],
}

const SHARED_TABS: Tab[] = [
  { to: paths.rules, label: "Rules", icon: ShieldCheckIcon },
  { to: paths.attribution, label: "Attribution", icon: TagIcon },
  { to: paths.agent, label: "Agent", icon: RobotIcon },
]

function isActive(pathname: string, tab: Tab) {
  return tab.exact ? pathname === tab.to : pathname === tab.to || pathname.startsWith(`${tab.to}/`)
}

function TabBadge({ tab, active }: { tab: Tab; active: boolean }) {
  const counts = useRuleCounts()
  const agentStatus = useAppStore((state) => state.agentStatus)
  if (tab.to === paths.rules && counts.proposed > 0) {
    return (
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", bounce: 0.5, duration: 0.4 }}
        className={cn(
          "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums",
          active ? "bg-background/20 text-background" : "bg-primary text-primary-foreground"
        )}
      >
        <SwapText value={counts.proposed} />
      </motion.span>
    )
  }
  if (tab.to === paths.agent && agentStatus === "connected") {
    return <LiveDot className={cn("size-1.5", active ? "text-background" : "text-brand")} />
  }
  return null
}

function NavTab({
  tab,
  active,
  hovered,
  chord,
  onHover,
}: {
  tab: Tab
  active: boolean
  hovered: boolean
  chord?: string
  onHover: () => void
}) {
  const link = (
    <Link
      to={tab.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/tab relative flex h-8 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "text-background" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <AnimatePresence>
        {hovered && !active ? (
          <motion.span
            layoutId="nav-hover"
            className="absolute inset-0 z-0 rounded-full bg-well"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={spring}
          />
        ) : null}
      </AnimatePresence>
      {active ? (
        <motion.span
          layoutId="nav-active"
          transition={spring}
          className="absolute inset-0 z-0 rounded-full bg-foreground shadow-[0_1px_2px_rgba(0,0,0,0.15)]"
        />
      ) : null}
      <tab.icon weight={active ? "fill" : "regular"} className="relative z-10 size-4 shrink-0 transition-transform group-hover/tab:animate-wiggle" />
      <span className="relative z-10">{tab.label}</span>
      <span className="relative z-10 flex items-center">
        <TabBadge tab={tab} active={active} />
      </span>
    </Link>
  )
  return (
    <li onPointerEnter={onHover}>
      {chord ? (
        <Tooltip>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="bottom">
            Go to {tab.label}
            <KbdGroup aria-hidden>
              <Kbd>G</Kbd>
              <Kbd>{chord}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      ) : (
        link
      )}
    </li>
  )
}

/**
 * The tab bar under the header: the current signal's pages, a divider, then
 * the shared pages. Switching signal blur-swaps the signal tabs while the
 * shared ones stay put; the dark active pill slides between tabs.
 */
export function NavBar() {
  const { pathname } = useLocation()
  const signal = useSignal()
  const [hovered, setHovered] = React.useState<string | null>(null)
  const navRef = React.useRef<HTMLElement>(null)
  // Attribution is optional (Settings → Attribution).
  const attributionOn = useAppStore((state) => state.attribution.enabled)
  const shared = attributionOn ? SHARED_TABS : SHARED_TABS.filter((tab) => tab.to !== paths.attribution)
  // The `g` chord's second key for each tab, shown in its tooltip.
  const chordByPath = React.useMemo(
    () => Object.fromEntries(Object.entries(navChords(signal)).map(([key, { to }]) => [to, key.toUpperCase()])),
    [signal]
  )

  // On phones the bar scrolls sideways: keep the current tab in view.
  React.useEffect(() => {
    navRef.current?.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "center" })
  }, [pathname, signal])

  const renderTab = (tab: Tab) => (
    <NavTab
      key={tab.to}
      tab={tab}
      active={isActive(pathname, tab)}
      hovered={hovered === tab.to}
      chord={chordByPath[tab.to]}
      onHover={() => setHovered(tab.to)}
    />
  )

  return (
    <div className="relative mx-auto flex h-12 w-full max-w-6xl items-center px-4 sm:px-6">
      <nav ref={navRef} aria-label="Main" className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <LayoutGroup id="main-nav">
          <div
            className="isolate flex w-max items-center gap-0.5 rounded-full border border-frame-border bg-frame p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
            onPointerLeave={() => setHovered(null)}
          >
            <div className="relative flex">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.ul
                  key={signal}
                  aria-label={`${SIGNAL_LABEL[signal]} pages`}
                  className="flex items-center gap-0.5"
                  initial={{ opacity: 0, filter: "blur(4px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, filter: "blur(4px)" }}
                  transition={{ duration: 0.22, ease: "easeInOut" }}
                >
                  {SIGNAL_TABS[signal].map(renderTab)}
                </motion.ul>
              </AnimatePresence>
            </div>
            <motion.div layout="position" transition={spring} className="flex items-center gap-0.5">
              <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
              <ul aria-label="Shared pages" className="flex items-center gap-0.5">
                {shared.map(renderTab)}
              </ul>
            </motion.div>
          </div>
        </LayoutGroup>
      </nav>
    </div>
  )
}
