import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  GearIcon,
  PencilSimpleIcon,
  PlusIcon,
  SealCheckIcon,
  SparkleIcon,
  TagIcon,
  UploadSimpleIcon,
  UserPlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { toast } from "sonner"

import { jobPath, metricPath, paths } from "@/app/paths"
import { CostText, readPricePer1k, useCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell, StatFrame } from "@/components/frame"
import { ExpandableList, ListRow } from "@/components/list-rows"
import { Expand, Reveal, Stagger } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { SignalBadge } from "@/components/signal-badge"
import { Tip } from "@/components/tip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ExportMenu, ImportDialog, downloadText } from "@/features/attribution/import-export"
import { LogsAttribution } from "@/features/attribution/logs-attribution"
import { OwnerDot } from "@/features/attribution/owner-badge"
import { OwnerEditorSheet } from "@/features/attribution/owner-editor"
import { buildAttributionSummaryMarkdown, buildLabelOwnerMarkdownReport, buildRuleOwnerMarkdownReport } from "@/features/attribution/report"
import {
  ownerDrilldownKey,
  useAttribution,
  useAttributionChain,
  useAttributionEnabled,
  useOwnerDrilldown,
  useRuleOwnerSavings,
  type AttributionState,
} from "@/features/attribution/use-attribution"
import { useConnection } from "@/hooks/use-cardinality"
import { useSignal } from "@/hooks/use-signal"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import {
  describeChain,
  estimateLabelOwnerSavings,
  viaText,
  type Attribution as AttributionModel,
  type AttributedOwner,
  type OwnerDrilldown,
} from "@/lib/core/attribution"
import { jobLabel } from "@/lib/core/jobs"
import { labelRuleKey, ownershipRuleProblem, suggestOwners, type Owner, type OwnerSavings } from "@/lib/core/owner-rules"
import { escapeRegex } from "@/lib/core/regex"
import type { Snapshot } from "@/lib/core/snapshot"
import { fetchOwnerDrilldown } from "@/lib/sources/attribution"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "owner"
}

const pct = (value: number) => (value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`)

/** Downloads a Markdown report for one owner, loading a label owner's drilldown first. */
function useReportDownload(snapshot: Snapshot) {
  const queryClient = useQueryClient()
  const connection = useConnection()
  const chain = useAttributionChain()
  const owners = useAppStore((state) => state.attribution.owners)
  return async (owner: AttributedOwner) => {
    const { rules, drilldowns, settings } = useAppStore.getState()
    const common = { snapshot, chain, rules, drilldowns, pricePer1k: readPricePer1k(settings), source: snapshot.host }
    let text: string
    if (owner.ownership) {
      text = buildRuleOwnerMarkdownReport({ ...common, owned: owner.ownership, owner: owners.find((item) => item.id === owner.id) })
    } else {
      if (!connection || owner.dimension === undefined) return
      try {
        const drilldown = await queryClient.fetchQuery({
          queryKey: ownerDrilldownKey(connection, chain, owner, snapshot.capturedAt),
          queryFn: ({ signal }) => fetchOwnerDrilldown(connection, chain, owner.dimension!, owner.name, signal),
          staleTime: 10 * 60_000,
        })
        text = buildLabelOwnerMarkdownReport({ ...common, owner, drilldown })
      } catch (error) {
        toast.error(`Could not load ${owner.name}`, { description: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    downloadText(`cardinal-${slug(owner.name)}-${(snapshot.capturedAt ?? new Date().toISOString()).slice(0, 10)}.md`, text, "text/markdown")
  }
}

/** Estimated savings of label owners whose drilldown is already cached. */
function useCachedEstimates(snapshot: Snapshot) {
  const queryClient = useQueryClient()
  const connection = useConnection()
  return (attribution: AttributionModel) => {
    const { rules, drilldowns } = useAppStore.getState()
    const estimates = new Map<string, number>()
    for (const owner of attribution.owners) {
      if (owner.source !== "label") continue
      const drill = queryClient.getQueryData<OwnerDrilldown>(ownerDrilldownKey(connection, attribution.chain, owner, snapshot.capturedAt))
      if (drill) estimates.set(owner.id, estimateLabelOwnerSavings(snapshot, drill, rules, drilldowns).savedSeries)
    }
    return estimates
  }
}

const BAR_OWNERS = 8

/** Stacked bar of the largest owners' shares, then Other, with Unattributed last in the brand colour. */
function ShareBarFrame({ state }: { state: AttributionState }) {
  const { attribution, loadingRules } = state
  const sorted = [...attribution.owners].sort((a, b) => b.series - a.series)
  const shown = sorted.slice(0, BAR_OWNERS).filter((owner) => owner.series > 0)
  const other = sorted.slice(BAR_OWNERS).reduce((sum, owner) => sum + owner.series, 0)
  const total = attribution.totalSeries
  const segments = [
    ...shown.map((owner) => ({ id: owner.id, name: owner.name, series: owner.series, percent: owner.percent, color: owner.color, kind: "owner" as const })),
    ...(other > 0 ? [{ id: "__other__", name: `${sorted.length - BAR_OWNERS} more`, series: other, percent: total ? (other / total) * 100 : 0, color: undefined, kind: "other" as const }] : []),
    ...(attribution.unattributed.series > 0
      ? [{ id: attribution.unattributed.id, name: "Unattributed", series: attribution.unattributed.series, percent: attribution.unattributed.percent, color: undefined, kind: "unattributed" as const }]
      : []),
  ]
  const dims = [
    ...attribution.chain.map((label, index) => ({ label, series: attribution.seriesByLabel[index], mono: true })),
    { label: "custom rules", series: attribution.seriesByRules, mono: false },
  ].filter((item) => item.series > 0)
  return (
    <Frame>
      <FrameHeader
        icon={TagIcon}
        title="Series by owner"
        meta={attribution.approximate ? "some counts approximate" : undefined}
        action={
          loadingRules ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Counting label rules…
            </span>
          ) : null
        }
      />
      <FrameWell className="flex flex-col gap-3 py-4">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-background/70" role="img" aria-label={segments.map((item) => `${item.name} ${pct(item.percent)}`).join(", ")}>
          {segments.map((item) => (
            <div
              key={item.id}
              title={`${item.name}: ${formatNumber(item.series)} series (${pct(item.percent)})`}
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
        {dims.length > 1 || attribution.chain.length ? (
          <p className="text-xs text-muted-foreground">
            {dims.map((item, index) => (
              <React.Fragment key={item.label}>
                {index ? " · " : ""}
                via <span className={cn(item.mono && "font-mono")}>{item.label}</span> {pct(total ? (item.series / total) * 100 : 0)}
              </React.Fragment>
            ))}
          </p>
        ) : null}
      </FrameWell>
    </Frame>
  )
}

function SavingsCell({ owner, savings }: { owner: AttributedOwner; savings?: OwnerSavings }) {
  const snapshot = useAppStore((state) => state.snapshot)
  const rules = useAppStore((state) => state.rules)
  const drilldowns = useAppStore((state) => state.drilldowns)
  const { data } = useOwnerDrilldown(owner, false)
  if (savings) {
    if (savings.savedSeries <= 0) return <span className="text-muted-foreground">0</span>
    return (
      <span className="text-brand-ink" title={savings.isEstimate ? "Estimate" : "Exact from the snapshot"}>
        {savings.isEstimate ? "~" : ""}
        {formatDelta(-savings.savedSeries)}
      </span>
    )
  }
  if (!data || !snapshot) {
    return (
      <span className="text-muted-foreground" title="Expand the owner to estimate its share of rule savings">
        –
      </span>
    )
  }
  const estimate = estimateLabelOwnerSavings(snapshot, data, rules, drilldowns)
  if (estimate.rules.length === 0) return <span className="text-muted-foreground" title="No active rule touches this owner's top metrics">0</span>
  if (estimate.savedSeries <= 0) return <span className="text-muted-foreground" title="Estimate from the owner's top 20 metrics">~0</span>
  return (
    <span className="text-brand-ink" title="Estimate: each rule's saving scaled by this owner's share of its metric">
      ~{formatDelta(-estimate.savedSeries)}
    </span>
  )
}

function Via({ owner }: { owner: AttributedOwner }) {
  const text = viaText(owner)
  if (!text) return null
  return <span className="shrink-0 rounded-full bg-background/70 px-1.5 text-[11px] text-muted-foreground">{text}</span>
}

function LabelOwnerDetail({ owner, total }: { owner: AttributedOwner; total: number }) {
  const snapshot = useAppStore((state) => state.snapshot)
  const rules = useAppStore((state) => state.rules)
  const drilldowns = useAppStore((state) => state.drilldowns)
  const chain = useAttributionChain()
  const { data, isPending, error, refetch } = useOwnerDrilldown(owner, true)
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        Could not load {owner.name}: {error.message}
        <Button variant="outline" size="xs" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  if (isPending || !data || !snapshot) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy>
        {[0, 1].map((key) => (
          <div key={key} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    )
  }
  const estimate = estimateLabelOwnerSavings(snapshot, data, rules, drilldowns)
  const scope = owner.dimension ? ` without ${chain.slice(0, owner.dimension).join(" or ")}` : ""
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Series with <span className="font-mono text-foreground">{`${owner.label}="${owner.name}"`}</span>
        {scope}: {formatNumber(owner.series)}, {pct(total ? (owner.series / total) * 100 : 0)} of all.
      </p>
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col pb-4">
          <span className="mb-1 text-xs font-medium text-muted-foreground">Top metrics</span>
          <ExpandableList
            initial={6}
            rows={data.metrics.map((item) => ({
              label: item.metric,
              value: formatNumber(item.series),
              percent: owner.series ? (item.series / owner.series) * 100 : 0,
              to: metricPath(item.metric),
              mono: true,
              leading: <OwnerDot color={owner.color} className="size-1.5 opacity-70" />,
            }))}
          />
        </div>
        <div className="flex min-w-0 flex-col pb-4">
          <span className="mb-1 text-xs font-medium text-muted-foreground">
            By <span className="font-mono">{data.breakdown.label}</span>
          </span>
          <ExpandableList
            initial={6}
            rows={data.breakdown.values.map((item) => ({
              label: item.value || `(no ${data.breakdown.label})`,
              value: formatNumber(item.series),
              percent: owner.series ? (item.series / owner.series) * 100 : 0,
              to: data.breakdown.label === "job" ? jobPath(item.value) : undefined,
              mono: Boolean(item.value),
              muted: !item.value,
            }))}
          />
        </div>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        {estimate.rules.length ? (
          <>
            <span>
              Estimate: {estimate.rules.length} active rule{estimate.rules.length === 1 ? "" : "s"} save about{" "}
              <span className="font-medium text-brand-ink tabular-nums">{formatNumber(estimate.savedSeries)}</span> of these series
            </span>
            {estimate.savedSeries > 0 ? <CostText series={estimate.savedSeries} suffix="saved" /> : null}
            <span className="text-muted-foreground/80">(each rule scaled by this owner's share of its metric; top 20 metrics only)</span>
          </>
        ) : (
          <span>No active rule touches this owner's top metrics.</span>
        )}
      </p>
    </div>
  )
}

function RuleOwnerDetail({ owner, savings }: { owner: AttributedOwner; savings?: OwnerSavings }) {
  const owned = owner.ownership
  if (!owned) return null
  if (owned.series === 0) return <p className="text-sm text-muted-foreground">Its rules match nothing that the labels and earlier owners left.</p>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col pb-4">
          <span className="mb-1 text-xs font-medium text-muted-foreground">Top metrics</span>
          <ExpandableList
            initial={6}
            rows={owned.metrics.slice(0, 25).map((item) => ({
              label: item.metric,
              value: formatNumber(item.series),
              percent: owned.series ? (item.series / owned.series) * 100 : 0,
              to: metricPath(item.metric),
              mono: true,
              leading: <OwnerDot color={owner.color} className="size-1.5 opacity-70" />,
            }))}
          />
        </div>
        <div className="flex min-w-0 flex-col pb-4">
          <span className="mb-1 text-xs font-medium text-muted-foreground">By job</span>
          <ExpandableList
            initial={6}
            rows={owned.jobs.slice(0, 25).map((item) => ({
              label: jobLabel(item.job),
              value: formatNumber(item.series),
              percent: owned.series ? (item.series / owned.series) * 100 : 0,
              to: jobPath(item.job),
              muted: item.job === "",
            }))}
          />
        </div>
      </div>
      <SavingsLine savings={savings} />
    </div>
  )
}

function SavingsLine({ savings }: { savings: OwnerSavings | undefined }) {
  if (!savings || savings.rules.length === 0) return <span className="text-xs text-muted-foreground">No active rules touch these series yet.</span>
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
      <span>
        {savings.rules.length} active rule{savings.rules.length === 1 ? "" : "s"} save{savings.rules.length === 1 ? "s" : ""}{" "}
        <span className="font-medium text-brand-ink tabular-nums">
          {savings.isEstimate ? "~" : ""}
          {formatDelta(-savings.savedSeries)}
        </span>{" "}
        series ({savings.percent.toFixed(1)}%)
      </span>
      {savings.savedSeries > 0 ? <CostText series={savings.savedSeries} suffix="saved" /> : null}
    </span>
  )
}

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_5.5rem_4rem_6.5rem_6rem_1.75rem]"

function OwnerRow({
  owner,
  total,
  savings,
  onReport,
}: {
  owner: AttributedOwner
  total: number
  savings?: OwnerSavings
  onReport: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const unattributed = owner.source === "unattributed"
  return (
    <li className={cn("rounded-2xl transition-colors", open && "bg-background/50", unattributed && "bg-brand/[0.06]")}>
      <div className={cn(ROW_GRID, "px-2 py-1.5")}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-2 rounded-lg py-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CaretRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          {unattributed ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" /> : <OwnerDot color={owner.color} />}
          <span className={cn("truncate", unattributed ? "font-medium text-brand-ink" : "font-medium", owner.source === "label" && "font-mono text-[13px]")} title={owner.name}>
            {owner.name}
          </span>
          <span className="hidden sm:inline-flex">
            <Via owner={owner} />
          </span>
        </button>
        <span className="text-right text-sm tabular-nums">{formatNumber(owner.series)}</span>
        <span className="text-right text-sm text-muted-foreground tabular-nums">{pct(owner.percent)}</span>
        <span className="hidden text-right sm:block">
          <CostText series={owner.series} />
        </span>
        <span className="hidden text-right text-sm tabular-nums sm:block">
          <SavingsCell owner={owner} savings={savings} />
        </span>
        <span className="hidden sm:block">
          <Tip label="Markdown report">
            <Button variant="ghost" size="icon-xs" aria-label={`Download the ${owner.name} report`} onClick={onReport}>
              <DownloadSimpleIcon />
            </Button>
          </Tip>
        </span>
      </div>
      <Expand open={open}>
        <div id={id} className="flex flex-col gap-3 px-3 pt-1 pb-4 sm:pl-9">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:hidden">
            <Via owner={owner} />
            <CostText series={owner.series} />
            <span>
              Rules save <SavingsCell owner={owner} savings={savings} />
            </span>
            <Button variant="ghost" size="xs" onClick={onReport}>
              <DownloadSimpleIcon data-icon="inline-start" />
              Report
            </Button>
          </div>
          {owner.source === "label" ? <LabelOwnerDetail owner={owner} total={total} /> : <RuleOwnerDetail owner={owner} savings={savings} />}
        </div>
      </Expand>
    </li>
  )
}

const TABLE_ROWS = 25

function OwnersTable({ attribution, savings, onReport }: { attribution: AttributionModel; savings: Map<string, OwnerSavings>; onReport: (owner: AttributedOwner) => void }) {
  const [all, setAll] = React.useState(false)
  const owners = [...attribution.owners].sort((a, b) => b.series - a.series)
  const shown = all ? owners : owners.slice(0, TABLE_ROWS)
  return (
    <Frame>
      <FrameHeader title="Owners" meta={`${formatNumber(attribution.owners.length)} · expand one for its metrics`} />
      <FrameWell className="px-2 py-2">
        <div className={cn(ROW_GRID, "px-2 pb-1 text-xs text-muted-foreground")}>
          <span className="pl-5.5">Owner</span>
          <span className="text-right">Series</span>
          <span className="text-right">Share</span>
          <span className="hidden text-right sm:block">Cost</span>
          <span className="hidden text-right sm:block" title="Series the active rules remove. ~ marks estimates; – means expand to estimate">
            Rules save
          </span>
          <span className="hidden sm:block" />
        </div>
        <ul className="flex flex-col">
          {[...shown, attribution.unattributed].map((owner) => (
            <OwnerRow key={owner.id} owner={owner} total={attribution.totalSeries} savings={savings.get(owner.id)} onReport={() => onReport(owner)} />
          ))}
        </ul>
        {owners.length > TABLE_ROWS ? (
          <div className="flex justify-center pt-1">
            <Button variant="ghost" size="sm" onClick={() => setAll((value) => !value)}>
              {all ? "Show fewer" : `Show all ${formatNumber(owners.length)} owners`}
            </Button>
          </div>
        ) : null}
      </FrameWell>
    </Frame>
  )
}

function AssignMenu({ job, owners }: { job: string; owners: Owner[] }) {
  const updateOwner = useAppStore((state) => state.updateOwner)
  const addOwner = useAppStore((state) => state.addOwner)
  const rule = { kind: "job" as const, pattern: escapeRegex(job) }
  if (job === "") {
    return (
      <span className="text-xs text-muted-foreground" title="Series without a job label can be owned by a metric prefix or label rule">
        use a label rule
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" aria-label={`Assign ${job} to an owner`}>
          <UserPlusIcon data-icon="inline-start" />
          Assign
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="truncate">Job {job}</DropdownMenuLabel>
        {owners.map((owner) => (
          <DropdownMenuItem
            key={owner.id}
            onSelect={() => {
              updateOwner(owner.id, { rules: [...owner.rules, rule] })
              toast.success(`${job} now belongs to ${owner.name}`)
            }}
          >
            <OwnerDot color={owner.color} />
            <span className="truncate">{owner.name}</span>
          </DropdownMenuItem>
        ))}
        {owners.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onSelect={() => {
            addOwner(job, [rule])
            toast.success(`Created owner ${job}`)
          }}
        >
          <PlusIcon />
          New owner “{job}”
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UnattributedFrame({ owner, chain, owners, onReport }: { owner: AttributedOwner; chain: string[]; owners: Owner[]; onReport: () => void }) {
  const owned = owner.ownership
  if (!owned || owned.series === 0) {
    return (
      <Frame>
        <FrameWell className="flex items-center gap-2 py-3 text-sm">
          <SealCheckIcon weight="fill" className="size-4 text-brand" />
          Every series has an owner.
        </FrameWell>
      </Frame>
    )
  }
  return (
    <Frame className="border-brand/40 shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand),transparent_88%)]">
      <FrameHeader
        icon={WarningCircleIcon}
        title={<span className="text-brand-ink">Unattributed</span>}
        meta={`${formatNumber(owned.series)} series · ${pct(owned.percent)} of all`}
        action={
          <Tip label="Markdown report">
            <Button variant="ghost" size="icon-xs" aria-label="Download the Unattributed report" onClick={onReport}>
              <DownloadSimpleIcon />
            </Button>
          </Tip>
        }
      />
      <FrameWell className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground">
            {chain.length ? `These series have no ${chain.join(", ")} label and no custom rule matches them.` : "No custom rule matches these series."} Assign their
            jobs so every series has someone to ask before it is cut.
          </p>
          <CostText series={owned.series} className="text-sm" />
        </div>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <div className="flex min-w-0 flex-col">
            <span className="mb-1 text-xs font-medium text-muted-foreground">Biggest unattributed jobs</span>
            {owned.jobs.slice(0, 6).map((item) => (
              <div key={item.job} className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ListRow label={jobLabel(item.job)} value={formatNumber(item.series)} to={jobPath(item.job)} muted={item.job === ""} />
                </div>
                <AssignMenu job={item.job} owners={owners} />
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-col pb-4">
            <span className="mb-1 text-xs font-medium text-muted-foreground">Biggest unattributed metrics</span>
            <ExpandableList
              initial={6}
              rows={owned.metrics.slice(0, 30).map((item) => ({
                label: item.metric,
                value: formatNumber(item.series),
                percent: owned.series ? (item.series / owned.series) * 100 : 0,
                to: metricPath(item.metric),
                mono: true,
              }))}
            />
          </div>
        </div>
      </FrameWell>
    </Frame>
  )
}

function CustomRulesFrame({
  state,
  snapshot,
  onEdit,
  onAdd,
  onImport,
}: {
  state: AttributionState
  snapshot: Snapshot
  onEdit: (id: string) => void
  onAdd: () => void
  onImport: () => void
}) {
  const owners = useAppStore((s) => s.attribution.owners)
  const moveOwner = useAppStore((s) => s.moveOwner)
  const setOwners = useAppStore((s) => s.setOwners)
  const byId = new Map(state.attribution.owners.map((owner) => [owner.id, owner]))
  const chain = state.attribution.chain
  const labelStatus = (owner: Owner) => {
    const keys = owner.rules.flatMap((rule) => (rule.kind === "label" && !ownershipRuleProblem(rule) ? [labelRuleKey(rule)] : []))
    const error = keys.map((key) => state.ruleErrors[key]).find(Boolean)
    return { loading: !error && keys.some((key) => state.attribution.pendingLabelRules.includes(key)), error }
  }
  return (
    <Frame>
      <FrameHeader
        icon={PencilSimpleIcon}
        title="Custom rules"
        meta={<span className="hidden sm:inline">{chain.length ? `for series without ${chain.join(", ")}` : "job, metric prefix and label rules"}</span>}
        action={
          <Button variant="ghost" size="xs" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" />
            Add owner
          </Button>
        }
      />
      <FrameWell className="flex flex-col gap-2 py-3">
        {owners.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-1 text-sm text-muted-foreground">
            <p>Map jobs, metric prefixes or labels to owners for series that none of the attribution labels claim.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const suggested = suggestOwners(snapshot.jobs)
                  if (!suggested.length) {
                    toast.error("No job names to group in this snapshot")
                    return
                  }
                  setOwners(suggested)
                  toast.success(`Suggested ${suggested.length} owner${suggested.length === 1 ? "" : "s"} from job names`, { description: "Rename and adjust them to match your org." })
                }}
              >
                <SparkleIcon data-icon="inline-start" />
                Suggest from job names
              </Button>
              <Button size="sm" variant="ghost" onClick={onImport}>
                <UploadSimpleIcon data-icon="inline-start" />
                Import
              </Button>
            </div>
          </div>
        ) : (
          <ol className="flex flex-col">
            {owners.map((owner, index) => {
              const item = byId.get(owner.id)
              const status = labelStatus(owner)
              const invalid = owner.rules.filter((rule) => ownershipRuleProblem(rule)).length
              return (
                <li key={owner.id} className="flex min-w-0 items-center gap-2 border-b border-well-border/70 py-1.5 last:border-b-0">
                  <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                  <button
                    type="button"
                    onClick={() => onEdit(owner.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-full text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    title={`Edit ${owner.name}`}
                  >
                    <OwnerDot color={owner.color} className="size-2.5" />
                    <span className="truncate font-medium">{owner.name}</span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {owner.rules.length} rule{owner.rules.length === 1 ? "" : "s"}
                    </span>
                    {invalid ? <span className="shrink-0 text-xs text-destructive">{invalid} invalid</span> : null}
                    {status.error ? <span className="shrink-0 truncate text-xs text-destructive">label rule failed</span> : null}
                    {status.loading ? <Spinner className="size-3 shrink-0" /> : null}
                  </button>
                  <span className="shrink-0 text-sm tabular-nums">{formatNumber(item?.series ?? 0)}</span>
                  <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{pct(item?.percent ?? 0)}</span>
                  <div className="flex shrink-0 items-center">
                    <Tip label="Earlier in matching order">
                      <Button variant="ghost" size="icon-xs" aria-label={`Move ${owner.name} up`} disabled={index === 0} onClick={() => moveOwner(owner.id, -1)}>
                        <ArrowUpIcon />
                      </Button>
                    </Tip>
                    <Tip label="Later in matching order">
                      <Button variant="ghost" size="icon-xs" aria-label={`Move ${owner.name} down`} disabled={index === owners.length - 1} onClick={() => moveOwner(owner.id, 1)}>
                        <ArrowDownIcon />
                      </Button>
                    </Tip>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </FrameWell>
    </Frame>
  )
}

function LoadingFrame({ state, chain }: { state: AttributionState; chain: string[] }) {
  const progress = state.progress
  return (
    <Frame>
      <FrameWell className="flex flex-col gap-3 py-5" aria-busy>
        <span className="flex items-center gap-2 text-sm">
          <Spinner className="size-4" />
          Resolving {describeChain(chain)} for every series…
        </span>
        {progress && progress.total > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Progress value={(progress.done / progress.total) * 100} className="h-1.5" />
            <span className="text-xs text-muted-foreground tabular-nums">
              Too large for one query: {progress.phase.toLowerCase()} {formatNumber(progress.done)} of {formatNumber(progress.total)}
            </span>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-16 rounded-2xl" />
          ))}
        </div>
      </FrameWell>
    </Frame>
  )
}

function Attribution({ snapshot }: { snapshot: Snapshot }) {
  const owners = useAppStore((state) => state.attribution.owners)
  const addOwner = useAppStore((state) => state.addOwner)
  const settings = useAppStore((state) => state.settings)
  const chain = useAttributionChain()
  const state = useAttribution()
  const savings = useRuleOwnerSavings(state && !state.loading ? state.attribution : null)
  const { price } = useCost()
  const [editing, setEditing] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)
  const report = useReportDownload(snapshot)
  const estimates = useCachedEstimates(snapshot)
  const queryClient = useQueryClient()

  const add = () => setEditing(addOwner(`Owner ${owners.length + 1}`).id)
  const described = describeChain(chain)
  const attribution = state?.attribution
  const ruleOwned = attribution?.owners.find((owner) => owner.id === editing)?.ownership

  const header = (
    <PageHeader
      title="Attribution"
      eyebrow={<SignalBadge signal="metrics" />}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {described ? (
              <>
                Attributed by <span className="font-mono text-foreground">{described}</span>
                {owners.length ? ", then custom rules" : ""}.
              </>
            ) : owners.length ? (
              "Attributed by custom rules only."
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
      actions={
        <>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            <UploadSimpleIcon data-icon="inline-start" />
            Import
          </Button>
          <ExportMenu
            owners={owners}
            summary={() =>
              attribution && !state?.loading
                ? buildAttributionSummaryMarkdown({ snapshot, attribution, savings, estimates: estimates(attribution), pricePer1k: readPricePer1k(settings), source: snapshot.host })
                : null
            }
          />
          <Button onClick={add}>
            <PlusIcon data-icon="inline-start" />
            Add owner
          </Button>
        </>
      }
    />
  )

  let body: React.ReactNode
  if (!state || !attribution) body = null
  else if (state.error) {
    body = (
      <Alert variant="destructive">
        <WarningCircleIcon />
        <AlertTitle>Could not resolve {described}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {state.error.message}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queryClient.resetQueries({ queryKey: ["attribution-chain"] })
              void queryClient.resetQueries({ queryKey: ["attribution-unlabelled"] })
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  } else if (state.loading) body = <LoadingFrame state={state} chain={chain} />
  else if (!chain.length && owners.length === 0) {
    body = (
      <EmptyState
        framed
        icon={TagIcon}
        title="Who owns these series?"
        description="Pick attribution labels such as team or namespace in Settings, or map jobs, metric prefixes and labels to owners with custom rules. Anything unclaimed shows up as Unattributed."
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to={`${paths.settings}#attribution`}>
              <GearIcon data-icon="inline-start" />
              Pick labels in Settings
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const suggested = suggestOwners(snapshot.jobs)
              if (!suggested.length) {
                toast.error("No job names to group in this snapshot")
                return
              }
              useAppStore.getState().setOwners(suggested)
              toast.success(`Suggested ${suggested.length} owner${suggested.length === 1 ? "" : "s"} from job names`, { description: "Rename and adjust them to match your org." })
            }}
          >
            <SparkleIcon data-icon="inline-start" />
            Suggest rules from job names
          </Button>
        </div>
      </EmptyState>
    )
  } else {
    const attributed = attribution.totalSeries - attribution.unattributed.series
    body = (
      <Stagger className="flex flex-col gap-4">
        {state.skippedJobs.length ? (
          <Reveal>
            <Alert>
              <WarningCircleIcon />
              <AlertTitle>Counted job by job</AlertTitle>
              <AlertDescription>
                The backend refused one query for all series; {formatNumber(state.skippedJobs.length)} job{state.skippedJobs.length === 1 ? "" : "s"} could not be counted and are missing.
              </AlertDescription>
            </Alert>
          </Reveal>
        ) : null}
        <Reveal className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatFrame
            label="Attributed"
            value={`${attribution.totalSeries ? (Math.floor((attributed / attribution.totalSeries) * 1000) / 10).toFixed(1) : "0"}%`}
            hint={`${formatNumber(attributed)} series`}
          />
          <StatFrame
            label="Unattributed"
            value={<span className={cn(attribution.unattributed.series > 0 && "text-brand-ink")}>{formatNumber(attribution.unattributed.series)}</span>}
            hint={`${pct(attribution.unattributed.percent)} of series`}
          />
          <StatFrame
            label="Owners"
            value={formatNumber(attribution.owners.length)}
            hint={`${formatNumber(attribution.owners.length - owners.length)} from labels, ${owners.length} from rules`}
          />
          <StatFrame
            label="Monthly cost"
            value={price !== undefined ? <CostText series={attribution.totalSeries} className="text-2xl text-foreground" /> : "—"}
            hint={price !== undefined ? `at $${price} per 1k series` : "Set a price in Settings"}
          />
        </Reveal>
        <Reveal>
          <ShareBarFrame state={state} />
        </Reveal>
        <Reveal>
          <OwnersTable attribution={attribution} savings={savings} onReport={(owner) => void report(owner)} />
        </Reveal>
        <Reveal>
          <UnattributedFrame owner={attribution.unattributed} chain={chain} owners={owners} onReport={() => void report(attribution.unattributed)} />
        </Reveal>
        <Reveal>
          <CustomRulesFrame state={state} snapshot={snapshot} onEdit={setEditing} onAdd={add} onImport={() => setImporting(true)} />
        </Reveal>
      </Stagger>
    )
  }

  return (
    <Page>
      {header}
      {body}
      <OwnerEditorSheet ownerId={editing} onOpenChange={(open) => !open && setEditing(null)} snapshot={snapshot} owned={ruleOwned} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </Page>
  )
}

export function AttributionPage() {
  const enabled = useAttributionEnabled()
  const signal = useSignal()
  if (!enabled) {
    return (
      <Page>
        <PageHeader
          title="Attribution"
          eyebrow={<SignalBadge signal={signal} />}
          description={`Who owns which ${signal === "logs" ? "streams" : "series"}, what they cost, and what your rules save each owner.`}
        />
        <EmptyState
          framed
          icon={TagIcon}
          title="Attribution is off"
          description={`See each ${signal === "logs" ? "stream" : "series"}'s owner by labels such as team or namespace.`}
        >
          <Button asChild>
            <Link to={`${paths.settings}#attribution`}>
              <GearIcon data-icon="inline-start" />
              Enable in Settings
            </Link>
          </Button>
        </EmptyState>
      </Page>
    )
  }
  if (signal === "logs") return <LogsAttribution />
  return <RequireSnapshot>{(snapshot) => <Attribution snapshot={snapshot} />}</RequireSnapshot>
}
