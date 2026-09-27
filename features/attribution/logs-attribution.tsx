import * as React from "react"
import { GearIcon, TagIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"

import { logGroupPath, paths } from "@/app/paths"
import { CostText, formatCost, useBytesCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell, StatFrame } from "@/components/frame"
import { AnimatedNumber, Reveal, Stagger } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { SignalBadge } from "@/components/signal-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { OwnerDot } from "@/features/attribution/owner-badge"
import { useAttributionChain } from "@/features/attribution/use-attribution"
import {
  STREAM_COUNT_OWNERS,
  useLogOwnerSavings,
  useLogOwnerStreams,
  useLogsAttribution,
  type LogsAttributionState,
} from "@/features/attribution/use-logs-attribution"
import { authErrorText } from "@/hooks/use-cardinality"
import { formatBytes } from "@/lib/core/bytes"
import { describeChain, viaText, type AttributedOwner } from "@/lib/core/attribution"
import type { LogOwnerSavings } from "@/lib/core/logs/attribution"
import { describeLogRule } from "@/lib/core/logs/rules"
import { LOGS_RANGE_SECONDS } from "@/lib/core/logs/snapshot"
import { describeOwnershipRule } from "@/lib/core/owner-rules"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

// Attribution under Logs: who owns the ingested bytes (and streams), by the
// same Primary / Secondary / Third labels and custom owner rules as metrics.

const pct = (value: number) => (value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`)
const CARD_OWNERS = 11

function perDayOf(state: LogsAttributionState) {
  return (bytes: number) => bytes / Math.max(LOGS_RANGE_SECONDS[state.snapshot.range] / 86400, 1 / 24)
}

function ShareBarFrame({ state }: { state: LogsAttributionState }) {
  const { attribution } = state
  const sorted = [...attribution.owners].sort((a, b) => b.series - a.series)
  const shown = sorted.slice(0, 8).filter((owner) => owner.series > 0)
  const other = sorted.slice(8).reduce((sum, owner) => sum + owner.series, 0)
  const total = attribution.totalSeries
  const segments = [
    ...shown.map((owner) => ({ id: owner.id, name: owner.name, percent: owner.percent, color: owner.color, kind: "owner" as const })),
    ...(other > 0 ? [{ id: "__other__", name: `${sorted.length - 8} more`, percent: total ? (other / total) * 100 : 0, color: undefined, kind: "other" as const }] : []),
    ...(attribution.unattributed.series > 0
      ? [{ id: "__unattributed__", name: "Unattributed", percent: attribution.unattributed.percent, color: undefined, kind: "unattributed" as const }]
      : []),
  ]
  const dims = [
    ...attribution.chain.map((label, index) => ({ label, bytes: attribution.seriesByLabel[index], mono: true })),
    { label: "custom rules", bytes: attribution.seriesByRules, mono: false },
  ].filter((item) => item.bytes > 0)
  return (
    <Frame>
      <FrameHeader
        icon={TagIcon}
        title="Bytes by owner"
        meta={attribution.approximate ? "some counts approximate" : undefined}
        action={
          state.loadingRules ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Measuring label rules…
            </span>
          ) : null
        }
      />
      <FrameWell className="flex flex-col gap-3 py-4">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-background/70" role="img" aria-label={segments.map((item) => `${item.name} ${pct(item.percent)}`).join(", ")}>
          {segments.map((item) => (
            <div
              key={item.id}
              title={`${item.name}: ${pct(item.percent)}`}
              className={cn(
                "h-full min-w-0.5 border-r-2 border-well transition-[width] duration-500 last:border-r-0 motion-reduce:transition-none",
                item.kind === "other" && "bg-muted-foreground/35",
                item.kind === "unattributed" && "bg-[repeating-linear-gradient(135deg,var(--brand)_0_4px,color-mix(in_oklch,var(--brand),transparent_45%)_4px_8px)]"
              )}
              style={{ width: `${item.percent}%`, backgroundColor: item.kind === "owner" ? item.color : undefined }}
            />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {segments.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-1.5">
              {item.kind === "unattributed" ? (
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" />
              ) : item.kind === "other" ? (
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/35" />
              ) : (
                <OwnerDot color={item.color} />
              )}
              <span className={cn("max-w-48 truncate", item.kind === "unattributed" && "font-medium text-brand-ink")}>{item.name}</span>
              <span className="text-muted-foreground tabular-nums">{pct(item.percent)}</span>
            </li>
          ))}
        </ul>
        {dims.length ? (
          <p className="text-xs text-muted-foreground">
            {dims.map((item, index) => (
              <React.Fragment key={item.label}>
                {index ? " · " : ""}
                via <span className={cn(item.mono && "font-mono")}>{item.label}</span> {pct(total ? (item.bytes / total) * 100 : 0)}
              </React.Fragment>
            ))}
          </p>
        ) : null}
      </FrameWell>
    </Frame>
  )
}

function SavingsLine({ savings, perDay, loading }: { savings?: LogOwnerSavings; perDay: (bytes: number) => number; loading: boolean }) {
  if (!savings || savings.rules.length === 0) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {loading ? (
          <>
            <Spinner className="size-3" />
            Splitting rule savings…
          </>
        ) : (
          "No active log rule saves this owner anything yet."
        )}
      </span>
    )
  }
  const saved = perDay(savings.savedBytes)
  return (
    <span
      className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground"
      title={savings.rules.map((item) => `${describeLogRule(item.rule)}: ${formatBytes(perDay(item.savedBytes))}/day`).join("\n")}
    >
      <span>
        {savings.rules.length} rule{savings.rules.length === 1 ? " saves" : "s save"}{" "}
        <span className="font-medium text-brand-ink tabular-nums">
          {savings.isEstimate ? "~" : ""}
          {formatBytes(saved)}/day
        </span>
      </span>
      {saved > 0 ? <CostText bytes={saved} per="day" /> : null}
    </span>
  )
}

function OwnerCard({
  owner,
  perDay,
  streams,
  savings,
  groupLabel,
  savingsLoading,
}: {
  owner: AttributedOwner
  perDay: (bytes: number) => number
  streams?: number
  savings?: LogOwnerSavings
  groupLabel: string
  savingsLoading: boolean
}) {
  const unattributed = owner.source === "unattributed"
  const via = viaText(owner)
  const jobs = owner.ownership?.jobs.slice(0, 3) ?? []
  return (
    <Frame className={cn(unattributed && "border-brand/30")}>
      <FrameHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            {unattributed ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" /> : <OwnerDot color={owner.color} />}
            <span className={cn("truncate", owner.source === "label" && "font-mono text-[13px]", unattributed && "text-brand-ink")} title={owner.name}>
              {owner.name}
            </span>
          </span>
        }
        action={via ? <span className="shrink-0 rounded-full bg-background/70 px-1.5 text-[11px] text-muted-foreground">{via}</span> : null}
      />
      <FrameWell className="flex flex-col gap-2 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xl font-medium tracking-tight tabular-nums">
            {formatBytes(perDay(owner.series))}
            <span className="ml-1 text-xs font-normal text-muted-foreground">/day</span>
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">{pct(owner.percent)}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-background/70">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", unattributed ? "bg-brand" : !owner.color && "bg-muted-foreground/60")}
            style={{ width: `${Math.max(1, owner.percent)}%`, backgroundColor: !unattributed ? owner.color : undefined }}
          />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          {streams !== undefined ? <span>{streams.toLocaleString()} streams</span> : null}
          <CostText bytes={perDay(owner.series)} per="day" />
        </div>
        {jobs.length ? (
          <p className="truncate text-xs text-muted-foreground">
            {jobs.map((item, index) => (
              <React.Fragment key={item.job}>
                {index ? ", " : ""}
                {item.job ? (
                  <Link to={logGroupPath(item.job)} className="font-mono hover:underline">
                    {item.job}
                  </Link>
                ) : (
                  <span>(no {groupLabel})</span>
                )}
              </React.Fragment>
            ))}
            {owner.ownership && owner.ownership.jobs.length > jobs.length ? ` +${owner.ownership.jobs.length - jobs.length}` : ""}
          </p>
        ) : null}
        <SavingsLine savings={savings} perDay={perDay} loading={savingsLoading} />
      </FrameWell>
    </Frame>
  )
}

function Body({ state }: { state: LogsAttributionState }) {
  const owners = useAppStore((store) => store.attribution.owners)
  const { price, cost } = useBytesCost()
  const chain = useAttributionChain()
  const savings = useLogOwnerSavings(state.loading ? null : state)
  const streams = useLogOwnerStreams(state.loading ? null : state)
  const queryClient = useQueryClient()
  const perDay = perDayOf(state)
  const { attribution, snapshot } = state
  const dayCost = cost(perDay(attribution.totalSeries))

  if (state.error) {
    return (
      <Alert variant="destructive">
        <WarningCircleIcon />
        <AlertTitle>Couldn't attribute log volume</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {authErrorText(state.error, "logs")}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queryClient.resetQueries({ queryKey: ["logs-attribution-chain"] })
              void queryClient.resetQueries({ queryKey: ["logs-attribution-unlabelled"] })
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (state.loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-24 rounded-[26px]" />
          ))}
        </div>
        <Skeleton className="h-28 rounded-[26px]" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-40 rounded-[26px]" />
          ))}
        </div>
      </div>
    )
  }
  if (!chain.length && owners.length === 0) {
    return (
      <EmptyState
        framed
        icon={TagIcon}
        title="Who owns these logs?"
        description="Pick attribution labels such as team or namespace in Settings, or add custom owner rules under Metrics attribution. Job rules match the group label here, label rules match stream labels."
      >
        <Button asChild>
          <Link to={`${paths.settings}#attribution`}>
            <GearIcon data-icon="inline-start" />
            Pick labels in Settings
          </Link>
        </Button>
      </EmptyState>
    )
  }

  const attributed = attribution.totalSeries - attribution.unattributed.series
  const sorted = [...attribution.owners].sort((a, b) => b.series - a.series)
  const labelOwners = attribution.owners.filter((owner) => owner.source === "label").length
  const ruleCount = owners.filter((owner) => owner.rules.some((rule) => rule.kind !== "metric_prefix")).length
  const covered = snapshot.totals.bytes > 0 ? attribution.totalSeries / snapshot.totals.bytes : 1
  const errors = Object.entries(state.ruleErrors)

  return (
    <Stagger className="flex flex-col gap-4">
      {covered < 0.98 ? (
        <Reveal>
          <Alert>
            <WarningCircleIcon />
            <AlertTitle>Some streams aren't counted</AlertTitle>
            <AlertDescription>
              Attribution covers streams with a <span className="font-mono">{snapshot.groupLabel}</span> label: {pct(covered * 100)} of the snapshot's
              bytes.
            </AlertDescription>
          </Alert>
        </Reveal>
      ) : null}
      {errors.length ? (
        <Reveal>
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Some label rules failed</AlertTitle>
            <AlertDescription>{errors.map(([key, message]) => `${key}: ${message}`).join("; ")}</AlertDescription>
          </Alert>
        </Reveal>
      ) : null}
      <Reveal className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatFrame
          label="Attributed"
          value={`${attribution.totalSeries ? (Math.floor((attributed / attribution.totalSeries) * 1000) / 10).toFixed(1) : "0"}%`}
          hint={`${formatBytes(perDay(attributed))}/day`}
        />
        <StatFrame
          label="Unattributed"
          value={<span className={cn(attribution.unattributed.series > 0 && "text-brand-ink")}>{formatBytes(perDay(attribution.unattributed.series))}</span>}
          hint={`per day · ${pct(attribution.unattributed.percent)}`}
        />
        <StatFrame label="Owners" value={attribution.owners.length.toLocaleString()} hint={`${labelOwners} from labels, ${ruleCount} from rules`} />
        <StatFrame
          label="Cost per day"
          value={dayCost === null ? "—" : <AnimatedNumber value={dayCost} format={formatCost} />}
          hint={price !== undefined ? `at ${formatCost(price)} per GB ingested` : "Set a price per GB in Settings"}
        />
      </Reveal>
      <Reveal>
        <ShareBarFrame state={state} />
      </Reveal>
      <Reveal className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[...sorted.slice(0, CARD_OWNERS), attribution.unattributed]
          .filter((owner) => owner.series > 0 || owner.source !== "unattributed")
          .map((owner) => (
            <OwnerCard
              key={owner.id}
              owner={owner}
              perDay={perDay}
              streams={streams.data?.[owner.id]}
              savings={savings.byOwner.get(owner.id)}
              savingsLoading={savings.loading}
              groupLabel={snapshot.groupLabel}
            />
          ))}
      </Reveal>
      <Reveal>
        <p className="text-xs text-muted-foreground">
          {sorted.length > CARD_OWNERS ? `${sorted.length - CARD_OWNERS} smaller owners not shown. ` : ""}
          Stream counts for the {STREAM_COUNT_OWNERS} largest label owners. Bytes come from Loki's index over the snapshot's {snapshot.range}; each
          active rule's saving is split by where its streams' bytes sit (line rules assume their lines are spread the same way, so they are
          estimates).
          {owners.length ? ` Custom rules: ${owners.map((owner) => `${owner.name} (${owner.rules.filter((rule) => rule.kind !== "metric_prefix").map(describeOwnershipRule).join(", ") || "no log rules"})`).join("; ")}.` : ""}
        </p>
      </Reveal>
    </Stagger>
  )
}

/** Attribution under Logs. */
export function LogsAttribution() {
  const chain = useAttributionChain()
  const owners = useAppStore((state) => state.attribution.owners)
  const state = useLogsAttribution()
  const described = describeChain(chain)
  return (
    <Page>
      <PageHeader
        title="Attribution"
        eyebrow={<SignalBadge signal="logs" />}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {described ? (
                <>
                  Log bytes attributed by <span className="font-mono text-foreground">{described}</span>
                  {owners.length ? ", then custom rules" : ""}.
                </>
              ) : owners.length ? (
                "Log bytes attributed by custom rules only."
              ) : (
                "Pick attribution labels or add custom rules."
              )}
            </span>
            <Link to={`${paths.settings}#attribution`} className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline">
              <GearIcon className="size-3.5" />
              Change in Settings
            </Link>
          </span>
        }
      />
      <RequireLogsSnapshot>{() => (state ? <Body state={state} /> : null)}</RequireLogsSnapshot>
    </Page>
  )
}
