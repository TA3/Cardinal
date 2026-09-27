import * as React from "react"
import {
  CaretDownIcon,
  CaretRightIcon,
  ChartBarIcon,
  InfoIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react"
import { Link, useSearchParams } from "react-router"

import { metricPath } from "@/app/paths"
import { CostText } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameWell, StatFrame } from "@/components/frame"
import { AnimatedNumber } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { HistogramDetail } from "@/features/histograms/histogram-detail"
import { useHistogramAnalysis } from "@/features/histograms/use-histograms"
import { Term } from "@/features/rules/term"
import { formatDelta, formatNumber } from "@/lib/cardinality/dashboard-helpers"
import {
  nativeSavings,
  roughReductionSavings,
  type ClassicHistogram,
} from "@/lib/core/histograms"
import type { Snapshot } from "@/lib/core/snapshot"

const PAGE_SIZE = 40

function Saving({ saved, className }: { saved: number; className?: string }) {
  return (
    <span className={`flex flex-col items-end ${className ?? ""}`}>
      <span className="tabular-nums">≈ {formatDelta(-saved)}</span>
      <CostText series={saved} />
    </span>
  )
}

function HeadHint({
  children,
  hint,
}: {
  children: React.ReactNode
  hint: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-help underline decoration-dotted underline-offset-[3px]"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-pretty">{hint}</TooltipContent>
    </Tooltip>
  )
}

function FamilyRow({
  family,
  index,
  open,
  onToggle,
  jobs,
  scrollTo = false,
}: {
  family: ClassicHistogram
  index: number
  open: boolean
  onToggle: () => void
  jobs: string[]
  /** Scroll the row into view on mount (opened from a link). */
  scrollTo?: boolean
}) {
  const ref = React.useRef<HTMLTableRowElement>(null)
  React.useEffect(() => {
    if (scrollTo)
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    // Only on mount: later expansions are the user's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const native = nativeSavings(family)
  const reduction = roughReductionSavings(family)
  const id = `family-${index}`
  return (
    <>
      <TableRow
        ref={ref}
        className="animate-blur-in cursor-pointer scroll-mt-24"
        style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
        onClick={(event) => {
          if (
            !(
              event.target instanceof Element &&
              event.target.closest("a,button")
            )
          )
            onToggle()
        }}
      >
        <TableCell className="w-8">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={`${open ? "Hide" : "Show"} buckets of ${family.base}`}
            onClick={onToggle}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {open ? <CaretDownIcon /> : <CaretRightIcon />}
          </button>
        </TableCell>
        <TableCell className="max-w-0 min-w-32 sm:min-w-40">
          <span className="flex min-w-0 items-center gap-2">
            <Link
              to={metricPath(family.bucketMetric)}
              title={family.bucketMetric}
              className="truncate font-mono text-xs hover:underline"
            >
              {family.base}
            </Link>
            {family.alsoNative ? (
              <Badge
                variant="outline"
                className="shrink-0 border-brand/40 text-brand-ink"
              >
                native too
              </Badge>
            ) : null}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatNumber(family.bucketSeries)}
        </TableCell>
        <TableCell className="hidden text-right tabular-nums sm:table-cell">
          {family.les.length}
        </TableCell>
        <TableCell className="hidden text-right tabular-nums md:table-cell">
          {formatNumber(family.labelSets)}
        </TableCell>
        <TableCell className="hidden text-right lg:table-cell">
          <Saving saved={reduction.saved} />
        </TableCell>
        <TableCell className="hidden text-right md:table-cell">
          <Saving saved={native.saved} />
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow id={id} className="hover:bg-transparent">
          <TableCell colSpan={7} className="whitespace-normal md:pl-10">
            {/* The table scrolls sideways on phones; keep the detail to the visible width. */}
            <div className="max-w-[calc(100vw-5.5rem)] md:max-w-none">
              <HistogramDetail family={family} jobs={jobs} />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function NativeCard({
  native,
}: {
  native: { metric: string; series: number }[] | null
}) {
  return (
    <Frame>
      <FrameHeader
        icon={ChartBarIcon}
        title="Already native"
        meta={
          native
            ? `${native.length} metric${native.length === 1 ? "" : "s"}`
            : "unknown"
        }
      />
      <FrameWell className="flex flex-col gap-2">
        {native === null ? (
          <p className="text-xs text-muted-foreground">
            Couldn't check: the backend refused the query (probably a query
            limit).
          </p>
        ) : native.length === 0 ? (
          <p className="text-xs text-pretty text-muted-foreground">
            No native histograms found. Every histogram here is classic: one
            series per bucket, plus _sum and _count.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {native.slice(0, 12).map((item) => (
              <li
                key={item.metric}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <Link
                  to={metricPath(item.metric)}
                  className="truncate font-mono hover:underline"
                >
                  {item.metric}
                </Link>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatNumber(item.series)} series
                </span>
              </li>
            ))}
            {native.length > 12 ? (
              <li className="text-xs text-muted-foreground">
                and {native.length - 12} more
              </li>
            ) : null}
          </ul>
        )}
      </FrameWell>
    </Frame>
  )
}

function HistogramsView({ snapshot }: { snapshot: Snapshot }) {
  const { data, isPending, error } = useHistogramAnalysis()
  const [params, setParams] = useSearchParams()
  const query = params.get("q") ?? ""
  const expanded = params.get("family")
  const [limit, setLimit] = React.useState(PAGE_SIZE)
  const deferred = React.useDeferredValue(query)
  const [linked] = React.useState(expanded)

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === "") next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true }
    )

  const families = React.useMemo(() => data?.families ?? [], [data])
  const rows = React.useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    return needle
      ? families.filter((family) => family.base.toLowerCase().includes(needle))
      : families
  }, [families, deferred])
  const jobsByMetric = React.useMemo(
    () =>
      new Map(snapshot.metrics.map((item) => [item.metric, item.jobs ?? []])),
    [snapshot]
  )
  const totals = React.useMemo(
    () =>
      families.reduce(
        (sum, family) => ({
          bucket: sum.bucket + family.bucketSeries,
          family: sum.family + family.familySeries,
          native: sum.native + nativeSavings(family).saved,
          reduction: sum.reduction + roughReductionSavings(family).saved,
        }),
        { bucket: 0, family: 0, native: 0, reduction: 0 }
      ),
    [families]
  )
  const expandedIndex = rows.findIndex((family) => family.base === expanded)
  const visible = Math.max(limit, expandedIndex + 1)
  const share = snapshot.totalSeries
    ? (totals.family / snapshot.totalSeries) * 100
    : 0

  return (
    <Page>
      <PageHeader
        title="Histograms"
        status={
          data ? `${formatNumber(families.length)} classic families` : undefined
        }
        description={
          <>
            Classic histograms store one series per{" "}
            <Term id="histogramBuckets">bucket</Term>, so they are often the
            biggest source of series. Keep fewer buckets with a relabel rule, or
            move to native histograms. Savings here are estimates.
          </>
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not count histogram buckets</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatFrame
          label="Histogram series"
          value={
            isPending ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <AnimatedNumber value={totals.family} />
            )
          }
          hint={isPending ? null : `${share.toFixed(1)}% of all series`}
        />
        <StatFrame
          label="Bucket series"
          value={
            isPending ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <AnimatedNumber value={totals.bucket} />
            )
          }
          hint={<CostText series={totals.bucket} />}
        />
        <StatFrame
          label="Keep ~6 buckets each"
          value={
            isPending ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <AnimatedNumber
                value={totals.reduction}
                format={(n) => `≈ ${Math.round(n).toLocaleString()}`}
              />
            )
          }
          hint={<CostText series={totals.reduction} suffix="saved" />}
        />
        <StatFrame
          label="All native"
          value={
            isPending ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <AnimatedNumber
                value={totals.native}
                format={(n) => `≈ ${Math.round(n).toLocaleString()}`}
              />
            )
          }
          hint={<CostText series={totals.native} suffix="saved" />}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <InputGroup className="sm:max-w-sm">
          <InputGroupInput
            placeholder="Filter families…"
            value={query}
            onChange={(event) => update({ q: event.target.value })}
          />
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <InputGroupText>{formatNumber(rows.length)}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <Card className="overflow-visible">
          <CardContent>
            {isPending ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={ChartBarIcon}
                title={
                  families.length
                    ? "No matching families"
                    : "No classic histograms"
                }
                description={
                  families.length
                    ? "Try a different name."
                    : "No _bucket metric with an le label is in this snapshot."
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Family</TableHead>
                    <TableHead className="text-right">
                      <span className="sm:hidden">Buckets</span>
                      <span className="hidden sm:inline">Bucket series</span>
                    </TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      <HeadHint hint="Distinct le values, including +Inf.">
                        le
                      </HeadHint>
                    </TableHead>
                    <TableHead className="hidden text-right md:table-cell">
                      <HeadHint hint="Distinct label sets: one histogram each. From the _count series, else bucket series ÷ le count. Each costs le + 2 series today.">
                        Label sets
                      </HeadHint>
                    </TableHead>
                    <TableHead className="hidden text-right lg:table-cell">
                      <HeadHint hint="Estimate for keeping about 6 buckets plus +Inf. Expand a row for a pick based on the real distribution.">
                        Keep ~6 buckets
                      </HeadHint>
                    </TableHead>
                    <TableHead className="hidden text-right md:table-cell">
                      <HeadHint hint="Estimate: about one series per label set instead of le + 2. Needs client, scrape and query changes; billing for native histograms may differ.">
                        Native
                      </HeadHint>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, visible).map((family, index) => (
                    <FamilyRow
                      key={family.base}
                      family={family}
                      index={index}
                      open={expanded === family.base}
                      onToggle={() =>
                        update({
                          family: expanded === family.base ? null : family.base,
                        })
                      }
                      jobs={jobsByMetric.get(family.bucketMetric) ?? []}
                      scrollTo={linked === family.base}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            {rows.length > visible ? (
              <div className="flex justify-center pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLimit(visible + PAGE_SIZE)}
                >
                  Show {Math.min(PAGE_SIZE, rows.length - visible)} more
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <NativeCard native={isPending ? [] : (data?.native ?? null)} />
        <Frame>
          <FrameHeader icon={InfoIcon} title="Which one?" />
          <FrameWell className="flex flex-col gap-2 text-xs text-pretty text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">
                Keep fewer buckets
              </span>{" "}
              is a relabel rule: no code change, and quantiles near the kept
              buckets stay accurate. Buckets your rules query are kept.
            </p>
            <p>
              <span className="font-medium text-foreground">
                Native histograms
              </span>{" "}
              cut far more and have finer resolution, but need client library
              support, protobuf scraping (Prometheus 2.40+) and query changes.
              Grafana Cloud may bill them differently.
            </p>
            {data?.partial ? (
              <p>
                Counts cover the {formatNumber(families.length)} largest
                families only; the full count hit a query limit.
              </p>
            ) : null}
          </FrameWell>
        </Frame>
      </div>
    </Page>
  )
}

export function HistogramsPage() {
  return (
    <RequireSnapshot>
      {(snapshot) => <HistogramsView snapshot={snapshot} />}
    </RequireSnapshot>
  )
}
