import * as React from "react"
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  InfoIcon,
  ProhibitIcon,
  RepeatIcon,
  WarningIcon } from "@phosphor-icons/react"
import { motion } from "motion/react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { metricPath, rulesPath } from "@/app/paths"
import { useCost, formatCost } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell, StatFrame } from "@/components/frame"
import { InfoTip } from "@/components/info-tip"
import { AnimatedNumber, Expand, FadeIn, Reveal, Stagger, SwapText } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatChurnPercent, formatCreationRate, formatRatio } from "@/features/churn/format"
import { useChurn, useLabelDrivers } from "@/features/churn/use-churn"
import { isAuthError } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import {
  CHURN_WINDOW_LABEL,
  CHURN_WINDOW_SECONDS,
  CHURN_WINDOWS,
  DEFAULT_CHURN_WINDOW,
  HIGH_CHURN_RATIO,
  churnCost,
  rankChurn,
  type ChurnRow,
  type ChurnWindow } from "@/lib/core/churn"
import { jobLabel } from "@/lib/core/jobs"
import { createRule } from "@/lib/core/rules"
import type { ChurnProgress } from "@/lib/sources/churn"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

const WINDOW_OPTIONS = CHURN_WINDOWS.map((value) => ({ value, label: value, title: `Series seen over the last ${CHURN_WINDOW_LABEL[value]}` }))
const SHOWN = 25

function ProgressLine({ progress, fallback }: { progress: ChurnProgress | null; fallback: string }) {
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null
  return (
    <div role="status" className="flex flex-col gap-1.5 text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        <SwapText value={progress?.phase ?? fallback} />
        {percent !== null ? (
          <span className="tabular-nums">
            {progress!.done.toLocaleString()} / {progress!.total.toLocaleString()}
          </span>
        ) : null}
      </span>
      {percent !== null ? <Progress value={percent} aria-label="Churn progress" className="h-1 max-w-md" /> : null}
    </div>
  )
}

/** Proposes dropping `label` from the pair; always a pending proposal, never an active rule. */
function useProposeDrop() {
  const addRules = useAppStore((state) => state.addRules)
  const navigate = useNavigate()
  return (row: Pick<ChurnRow, "metric" | "job">, label: string, rationale: string) => {
    const rule = createRule({
      kind: "drop_labels",
      selector: { metric: row.metric, job: row.job },
      labels: [label],
      origin: "user",
      status: "proposed",
      rationale })
    const { added } = addRules([rule])
    if (added) {
      toast.success(`Proposed dropping ${label} from ${row.metric}`, {
        description: "It waits in Rules for review, where its impact is measured.",
        action: { label: "Review", onClick: () => navigate(rulesPath("proposed")) } })
    } else {
      toast.info(`A rule already drops ${label} from ${row.metric}`)
    }
  }
}

function DriversPanel({ row, window }: { row: ChurnRow; window: ChurnWindow }) {
  const { data, error, isPending, progress } = useLabelDrivers(row.metric, row.job, window, true)
  const rules = useAppStore((state) => state.rules)
  const propose = useProposeDrop()
  const driver = data?.driver
  const covered =
    driver !== undefined &&
    rules.some(
      (rule) =>
        rule.status !== "rejected" &&
        rule.kind === "drop_labels" &&
        rule.selector.metric === row.metric &&
        (rule.selector.job === undefined || rule.selector.job === row.job) &&
        rule.labels.includes(driver.label)
    )
  const maxJump = Math.max(1, ...(data?.labels.map((item) => item.jump) ?? [0]))

  return (
    <div className="flex flex-col gap-3 py-2 pr-1 pl-7">
      {isPending ? (
        <ProgressLine progress={progress} fallback="Comparing label values" />
      ) : error ? (
        <p className="text-sm text-muted-foreground">{isAuthError(error) ? "Unauthorized (HTTP 401). Enter your token to load label drivers." : error.message}</p>
      ) : data ? (
        <FadeIn className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {driver ? (
              <>
                <span className="font-mono text-[13px] text-foreground">{driver.label}</span> took {formatNumber(driver.seen)} distinct
                values over the last {CHURN_WINDOW_LABEL[window]} but has {formatNumber(driver.now)} now: it is the likely churn driver.
              </>
            ) : (
              "No label gained or lost values over this window: the churn comes from whole series restarting with the same labels."
            )}
          </p>
          <ul className="flex flex-col gap-1">
            {data.labels.slice(0, 8).map((item) => (
              <li key={item.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                <span className={cn("truncate font-mono text-[13px]", item === driver ? "text-brand-ink" : "text-muted-foreground")} title={item.label}>
                  {item.label}
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <motion.span
                    className="block h-full rounded-full bg-brand"
                    initial={{ width: 0 }}
                    animate={{ width: `${(item.jump / maxJump) * 100}%` }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                  />
                </span>
                <span className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatNumber(item.seen)} → {formatNumber(item.now)}
                </span>
              </li>
            ))}
          </ul>
          {data.skippedLabels.length ? (
            <p className="text-xs text-muted-foreground">Could not measure {data.skippedLabels.join(", ")} (query failed or hit a limit).</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {driver ? (
              <Button
                size="sm"
                variant="outline"
                disabled={covered}
                onClick={() =>
                  propose(
                    row,
                    driver.label,
                    `Churn: ${driver.label} took ${driver.seen} distinct values over the last ${window} but has ${driver.now} now, ` +
                      `so ${row.churned} series of this metric came and went. Dropping it merges those series.`
                  )
                }
              >
                <ProhibitIcon data-icon="inline-start" />
                {covered ? `Drop ${driver.label}: proposed` : `Drop label ${driver.label}`}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" asChild>
              <Link to={metricPath(row.metric)}>
                <ArrowSquareOutIcon data-icon="inline-start" />
                Open metric
              </Link>
            </Button>
          </div>
        </FadeIn>
      ) : null}
    </div>
  )
}

function subscribeResize(listener: () => void) {
  globalThis.addEventListener("resize", listener)
  return () => globalThis.removeEventListener("resize", listener)
}

/**
 * Columns the table shows at this width (Job from md, Seen/Active from sm).
 * Full-width rows must span exactly these: extra colSpan adds phantom columns
 * that steal width from Metric in a fixed-layout table.
 */
function useVisibleColumns() {
  return React.useSyncExternalStore(subscribeResize, () =>
    globalThis.matchMedia("(min-width: 48rem)").matches ? 6 : globalThis.matchMedia("(min-width: 40rem)").matches ? 5 : 3
  )
}

function ChurnTable({ rows, window }: { rows: ChurnRow[]; window: ChurnWindow }) {
  const columns = useVisibleColumns()
  const [open, setOpen] = React.useState<string | null>(null)
  const [all, setAll] = React.useState(false)
  const shown = all ? rows : rows.slice(0, SHOWN)
  const keyOf = (row: ChurnRow) => JSON.stringify([row.job, row.metric])

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>Metric</TableHead>
          <TableHead className="hidden w-40 md:table-cell">Job</TableHead>
          <TableHead className="hidden w-24 text-right sm:table-cell">Seen</TableHead>
          <TableHead className="hidden w-24 text-right sm:table-cell">Active</TableHead>
          <TableHead className="w-24 text-right">Churned</TableHead>
          <TableHead className="w-20 text-right">Ratio</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((row, index) => {
          const key = keyOf(row)
          const expanded = open === key
          return (
            <React.Fragment key={key}>
              <TableRow
                className="animate-blur-in cursor-pointer"
                style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
                onClick={(event) => {
                  if (!(event.target instanceof Element && event.target.closest("a"))) setOpen(expanded ? null : key)
                }}
              >
                <TableCell className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "Show"} why ${row.metric} churns`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setOpen(expanded ? null : key)
                      }}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ type: "spring", bounce: 0.2, duration: 0.35 }} className="flex">
                        <CaretRightIcon className="size-3.5" />
                      </motion.span>
                    </button>
                    <div className="flex min-w-0 flex-col">
                      <Link
                        to={metricPath(row.metric)}
                        title={row.metric}
                        className="truncate rounded-sm font-mono text-[13px] hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {row.metric}
                      </Link>
                      <span className={cn("truncate text-xs text-muted-foreground md:hidden", row.job === "" && "italic")}>{jobLabel(row.job)}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className={cn("hidden truncate md:table-cell", row.job === "" && "text-muted-foreground italic")} title={jobLabel(row.job)}>
                  {jobLabel(row.job)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatNumber(row.seen)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatNumber(row.active)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatNumber(row.churned)}</TableCell>
                <TableCell className="text-right">
                  {row.high ? (
                    <Badge variant="outline" className="border-brand/40 text-brand-ink tabular-nums" title={`Seen / active above ${HIGH_CHURN_RATIO}`}>
                      {formatRatio(row.ratio)}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground tabular-nums">{formatRatio(row.ratio)}</span>
                  )}
                </TableCell>
              </TableRow>
              {expanded ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns} className="p-0 whitespace-normal">
                    <Expand open>
                      <DriversPanel row={row} window={window} />
                    </Expand>
                  </TableCell>
                </TableRow>
              ) : null}
            </React.Fragment>
          )
        })}
        {rows.length > SHOWN ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns} className="text-center">
              <Button size="xs" variant="ghost" onClick={() => setAll((value) => !value)}>
                {all ? "Show fewer" : `Show all ${rows.length.toLocaleString()}`}
              </Button>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

function Churn() {
  const [window, setWindow] = React.useState<ChurnWindow>(DEFAULT_CHURN_WINDOW)
  const { data, error, isPending, isFetching, refetch, progress } = useChurn(window)
  const { price } = useCost()
  const ranked = React.useMemo(() => (data ? rankChurn(data.rows) : []), [data])
  const summary = data?.summary
  const cost = summary ? churnCost(summary.churned, price) : null

  return (
    <Page>
      <PageHeader
        title="Churn"
        status={
          summary ? (
            <>
              <RepeatIcon className="size-4" />
              <SwapText value={`${formatChurnPercent(summary.churnPercent)} churn`} />
            </>
          ) : undefined
        }
        description={`Series that appeared and disappeared within the window. Grafana Cloud and Mimir bill on series seen over time, so these cost money, but an instant active-series count never shows them.`}
        actions={
          <>
            <SegmentedControl aria-label="Churn window" value={window} onValueChange={setWindow} options={WINDOW_OPTIONS} />
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? <Spinner data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
              Refresh
            </Button>
          </>
        }
      />

      {isPending ? (
        <Stagger className="flex flex-col gap-4">
          <ProgressLine progress={progress} fallback={`Counting series seen over the last ${CHURN_WINDOW_LABEL[window]}`} />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Reveal key={index}>
                <Skeleton className="h-[104px] rounded-[26px]" />
              </Reveal>
            ))}
          </div>
        </Stagger>
      ) : error ? (
        <EmptyState
          framed
          icon={WarningIcon}
          title="Couldn't measure churn"
          description={isAuthError(error) ? "Unauthorized: the backend rejected the request (HTTP 401). Enter your token and retry." : error.message}
        >
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </EmptyState>
      ) : data && summary ? (
        <Stagger className="flex flex-col gap-4">
          {isFetching && progress ? <ProgressLine progress={progress} fallback="Refreshing" /> : null}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Reveal>
              <StatFrame
                label={`Seen in ${window}`}
                value={<AnimatedNumber value={summary.seen} />}
                hint={`${formatNumber(summary.churningPairs)} of ${formatNumber(data.rows.length)} job/metric pairs churned`}
              />
            </Reveal>
            <Reveal>
              <StatFrame label="Active now" value={<AnimatedNumber value={summary.active} />} hint="Counted at the same instant" />
            </Reveal>
            <Reveal>
              <StatFrame
                label="Churned"
                value={
                  <span className="flex items-baseline gap-2">
                    <AnimatedNumber value={summary.churned} />
                    <span className="text-sm font-normal text-brand-ink">{formatChurnPercent(summary.churnPercent)}</span>
                  </span>
                }
                hint={
                  <span className="inline-flex items-center gap-1">
                    {cost?.monthly != null ? `≈ ${formatCost(cost.monthly)}/mo, roughly` : price === undefined ? "Set a price in Settings to see cost" : "Seen but not active now"}
                    {cost ? <InfoTip label="How churn affects cost">{cost.note}</InfoTip> : null}
                  </span>
                }
              />
            </Reveal>
            <Reveal>
              <StatFrame
                label="Series created"
                value={data.creationRate === null ? "—" : formatCreationRate(data.creationRate)}
                hint={
                  data.creationRate === null ? (
                    "Not exposed by this backend"
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      ≈ {formatNumber(Math.round(data.creationRate * CHURN_WINDOW_SECONDS[window]))} in {window}
                      <InfoTip label="Where the creation rate comes from">
                        From prometheus_tsdb_head_series_created_total. On Mimir or Grafana Cloud it describes the Prometheus servers that report it, not
                        the backend itself.
                      </InfoTip>
                    </span>
                  )
                }
              />
            </Reveal>
          </div>

          {data.method === "per-job" ? (
            <Reveal>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <InfoIcon className="size-4 shrink-0" />
                The full query hit a backend limit, so jobs were measured one by one
                {data.skippedJobs.length ? `; ${data.skippedJobs.length} job${data.skippedJobs.length === 1 ? " was" : "s were"} skipped` : ""}.
              </p>
            </Reveal>
          ) : null}

          <Reveal>
            <Frame>
              <FrameHeader
                icon={RepeatIcon}
                title="Top churning pairs"
                meta={`by series that came and went in the last ${CHURN_WINDOW_LABEL[window]}`}
              />
              <FrameWell className="px-2 py-1">
                {ranked.length ? (
                  <ChurnTable key={window} rows={ranked} window={window} />
                ) : (
                  <EmptyState
                    compact
                    icon={RepeatIcon}
                    title="No churn in this window"
                    description={`Every series seen over the last ${CHURN_WINDOW_LABEL[window]} is still active. Try a longer window.`}
                  />
                )}
              </FrameWell>
            </Frame>
          </Reveal>
        </Stagger>
      ) : null}
    </Page>
  )
}

export function ChurnPage() {
  return <RequireSnapshot>{() => <Churn />}</RequireSnapshot>
}
