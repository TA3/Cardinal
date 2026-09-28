import * as React from "react"
import { ArrowClockwiseIcon, FingerprintIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react"
import { Link, useSearchParams } from "react-router"

import { paths } from "@/app/paths"
import { Combobox } from "@/components/combobox"
import { CostText } from "@/components/cost-text"
import { EmptyState } from "@/components/empty-state"
import { Frame, FrameHeader, FrameLink, FrameWell, StatFrame } from "@/components/frame"
import { InfoTip } from "@/components/info-tip"
import { AnimatedNumber, Reveal, Stagger, SwapText } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { RequireLogsSnapshot } from "@/components/require-snapshot"
import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { PatternsTable, patternTableRows, type PatternTableRow } from "@/features/logs/pattern-table"
import {
  PATTERN_RANGE_SECONDS,
  PATTERN_RANGES,
  patternStepSeconds,
  usePatterns,
  useServicesPatterns,
  type PatternRange,
  type ServicePatterns,
} from "@/features/logs/patterns-data"
import { groupLink } from "@/features/logs/streams-shared"
import { formatSpan } from "@/features/logs/volume-parts"
import { Term } from "@/features/rules/term"
import { authErrorText, useLogsAdaptive } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { BYTES_NOTE, formatBytes } from "@/lib/core/bytes"
import { MIN_PATTERN_COVERAGE, patternSpanSeconds } from "@/lib/core/logs/patterns"
import { groupNoun } from "@/lib/core/logs/snapshot"
import type { LogsSnapshot } from "@/lib/core/logs/types"

// Patterns: the line templates Loki's pattern ingester found for a service
// (or the top five), ranked by lines, with estimated bytes and the same Drop
// lines / Sample / Protect toggles as the stream group page.

type Mode = "service" | "top"

const TOP_SERVICES = 5

const RANGE_OPTIONS = PATTERN_RANGES.map((value) => ({ value, label: value, title: `Patterns seen over the last ${value}` }))

function NoIngester() {
  return (
    <EmptyState
      framed
      icon={FingerprintIcon}
      title="Your Loki doesn't run the pattern ingester"
      description={
        <>
          Patterns need Loki 3.0 or later with <code className="font-mono text-[13px]">pattern_ingester.enabled: true</code> (Grafana Cloud has it on). Until then, the
          Volume page shows which services and labels send the most bytes.
        </>
      }
    >
      <Button asChild variant="outline">
        <Link to={paths.logVolume}>Open Volume</Link>
      </Button>
    </EmptyState>
  )
}

function AdaptiveLogsHint() {
  const adaptive = useLogsAdaptive()
  if (!adaptive) return null
  return (
    <Reveal>
      <Frame>
        <FrameHeader
          icon={SparkleIcon}
          title="Adaptive Logs"
          meta="Grafana Cloud recommends drop rates per pattern from what you query"
          action={<FrameLink to={paths.recommendations}>Recommendations</FrameLink>}
        />
      </Frame>
    </Reveal>
  )
}

function Patterns({ snapshot }: { snapshot: LogsSnapshot }) {
  const [params, setParams] = useSearchParams()
  const groupLabel = snapshot.groupLabel
  const groups = snapshot.groups
  const requested = params.get("service")
  const service = requested && requested !== "" ? requested : (groups[0]?.value ?? "")
  const mode: Mode = params.get("mode") === "top" ? "top" : "service"
  const [range, setRange] = React.useState<PatternRange>("3h")

  const setService = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set("service", value)
        next.delete("mode")
        return next
      },
      { replace: true }
    )
  const setMode = (value: Mode) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value === "top") next.set("mode", "top")
        else next.delete("mode")
        return next
      },
      { replace: true }
    )

  const topServices = React.useMemo(() => groups.slice(0, TOP_SERVICES).map((group) => group.value), [groups])
  const single = usePatterns(groupLabel, mode === "service" ? service : undefined, range)
  const multi = useServicesPatterns(groupLabel, topServices, range, mode === "top")

  const results: Array<{ service: string; data: ServicePatterns | undefined; error: Error | null; isPending: boolean }> =
    mode === "service" ? [{ service, data: single.data, error: single.error, isPending: single.isPending }] : multi

  const rows: PatternTableRow[] = []
  const coverage = new Map<string, number | null>()
  const daily = new Map<string, number | null>()
  for (const result of results) {
    const table = patternTableRows(snapshot, groupLabel, result.service, result.data)
    coverage.set(result.service, table.coverage)
    daily.set(result.service, table.bytesPerDay)
    rows.push(...table.rows)
  }
  if (mode === "top") rows.sort((a, b) => (b.bytesPerDay ?? -1) - (a.bytesPerDay ?? -1) || b.count - a.count)

  const missing = results.some((result) => result.data && result.data.patterns === null)
  const error = results.find((result) => result.error)?.error ?? null
  const loaded = results.filter((result) => !result.isPending).length
  const pending = loaded < results.length
  const span = patternSpanSeconds(rows)
  const top = rows[0]
  const serviceDaily = mode === "service" ? (daily.get(service) ?? null) : null
  const serviceCoverage = mode === "service" ? (coverage.get(service) ?? null) : null
  const refetch = () => {
    if (mode === "service") void single.refetch()
    else for (const result of multi) void result.refetch()
  }

  const serviceOptions = React.useMemo(
    () => groups.map((group) => ({ value: group.value, detail: formatBytes(group.bytes) })),
    [groups]
  )

  return (
    <Page>
      <PageHeader
        title="Patterns"
        status={
          rows.length ? (
            <>
              <FingerprintIcon className="size-4" />
              <SwapText value={`${formatNumber(rows.length)} patterns`} />
            </>
          ) : undefined
        }
        description={
          <>
            <Term id="logPattern">Line patterns</Term> Loki found in {mode === "top" ? `your top ${TOP_SERVICES} ${groupNoun(groupLabel)}` : service || `a ${groupNoun(groupLabel, false)}`}
            , ranked by lines. Drop or sample the noisy ones and protect the ones you need; the line regex comes from the pattern.
          </>
        }
        actions={
          <>
            <SegmentedControl
              aria-label="Scope"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "service", label: groupNoun(groupLabel, false).replace(/^\w/, (c) => c.toUpperCase()), title: `One ${groupNoun(groupLabel, false)}` },
                { value: "top", label: `Top ${TOP_SERVICES}`, title: `The ${TOP_SERVICES} largest ${groupNoun(groupLabel)} by volume, one after another` },
              ]}
            />
            {mode === "service" ? (
              <Combobox aria-label={`Choose a ${groupNoun(groupLabel, false)}`} value={service} onValueChange={setService} options={serviceOptions} placeholder={`Search ${groupNoun(groupLabel)}…`} />
            ) : null}
            <SegmentedControl aria-label="Range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />
            <Button variant="outline" onClick={refetch} disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
              Refresh
            </Button>
          </>
        }
      />

      {!groups.length ? (
        <EmptyState framed icon={FingerprintIcon} title={`No ${groupNoun(groupLabel)} in the snapshot`} description="Take a new logs snapshot on the overview." />
      ) : missing && !rows.length ? (
        <NoIngester />
      ) : error && !rows.length ? (
        <EmptyState
          framed
          icon={WarningIcon}
          title="Couldn't load patterns"
          description={authErrorText(error, "logs")}
        >
          <Button variant="outline" onClick={refetch}>
            Retry
          </Button>
        </EmptyState>
      ) : (
        <Stagger className="flex flex-col gap-4">
          {mode === "top" && pending ? (
            <div role="status" className="flex max-w-md flex-col gap-1.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Spinner className="size-3.5" />
                Loading patterns, one {groupNoun(groupLabel, false)} at a time
                <span className="tabular-nums">
                  {loaded} / {results.length}
                </span>
              </span>
              <Progress value={(loaded / Math.max(1, results.length)) * 100} aria-label="Patterns progress" className="h-1" />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Reveal>
              <StatFrame
                label="Patterns"
                value={pending && !rows.length ? "—" : <AnimatedNumber value={rows.length} />}
                hint={span ? `covering the last ${formatSpan(span)}` : `over the last ${range}`}
              />
            </Reveal>
            <Reveal>
              <StatFrame
                label="Largest pattern"
                value={top ? <AnimatedNumber value={top.lineShare * 100} format={(value) => `${value.toFixed(value >= 10 ? 0 : 1)}%`} /> : "—"}
                hint={top ? `of ${mode === "top" ? top.service : "the"} lines · ${formatNumber(top.count)} lines` : undefined}
              />
            </Reveal>
            <Reveal className="col-span-2 lg:col-span-1">
              <StatFrame
                label={mode === "top" ? "Top pattern volume" : `${groupNoun(groupLabel, false).replace(/^\w/, (c) => c.toUpperCase())} volume`}
                value={
                  mode === "top" ? (
                    top?.bytesPerDay != null ? (
                      <AnimatedNumber value={top.bytesPerDay} format={(value) => `${formatBytes(value)}/day`} />
                    ) : (
                      "—"
                    )
                  ) : serviceDaily !== null ? (
                    <AnimatedNumber value={serviceDaily} format={(value) => `${formatBytes(value)}/day`} />
                  ) : (
                    "—"
                  )
                }
                hint={
                  <span className="inline-flex items-center gap-1">
                    {serviceCoverage !== null ? `patterns cover ~${Math.round(serviceCoverage * 100)}% of lines` : mode === "top" ? "estimated" : null}
                    {mode === "service" && serviceDaily !== null ? <CostText bytes={serviceDaily} per="day" /> : null}
                    <InfoTip label="How pattern volume is estimated">
                      A pattern's bytes are its share of the {groupNoun(groupLabel, false)}'s lines times the {groupNoun(groupLabel, false)}'s bytes per day (index/volume,
                      an estimate that reads high). When the pattern ingester saw under {MIN_PATTERN_COVERAGE * 100}% of the lines Loki indexed, the share is its count
                      over all lines instead. Expand a pattern to measure its byte share with bytes_over_time. {BYTES_NOTE}.
                    </InfoTip>
                  </span>
                }
              />
            </Reveal>
          </div>

          <AdaptiveLogsHint />

          <Reveal>
            <Frame>
              <FrameHeader
                icon={FingerprintIcon}
                title={mode === "top" ? `Top ${TOP_SERVICES} ${groupNoun(groupLabel)}` : service}
                meta={`last ${range}, step ${formatSpan(patternStepSeconds(range))}`}
                action={
                  mode === "service" && service ? <FrameLink to={groupLink(service, groupLabel)}>Open {groupNoun(groupLabel, false)}</FrameLink> : undefined
                }
              />
              <FrameWell className="px-2 py-1">
                {pending && !rows.length ? (
                  <div className="flex flex-col gap-2 p-2">
                    {Array.from({ length: 6 }, (_, index) => (
                      <Skeleton key={index} className="h-10 rounded-lg" />
                    ))}
                  </div>
                ) : rows.length ? (
                  <PatternsTable key={`${mode}-${service}-${range}`} rows={rows} groupLabel={groupLabel} range={range} showService={mode === "top"} />
                ) : (
                  <EmptyState
                    compact
                    icon={FingerprintIcon}
                    title="No patterns yet"
                    description={`Loki found no patterns in the last ${range}. The pattern ingester keeps about ${formatSpan(PATTERN_RANGE_SECONDS["3h"])} and needs a steady flow of lines.`}
                  />
                )}
              </FrameWell>
            </Frame>
          </Reveal>
          {missing && rows.length ? (
            <p className="text-xs text-muted-foreground">Some {groupNoun(groupLabel)} returned no pattern data (the pattern endpoint isn't available for them).</p>
          ) : null}
        </Stagger>
      )}
    </Page>
  )
}

export function LogPatternsPage() {
  return <RequireLogsSnapshot>{(snapshot) => <Patterns snapshot={snapshot} />}</RequireLogsSnapshot>
}
