import * as React from "react"
import { MagnifyingGlassIcon, TagIcon, XIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { Link, useSearchParams } from "react-router"

import { paths } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { DropScopeToggle } from "@/components/rule-parts"
import { SegmentedControl } from "@/components/segmented-control"
import { Card, CardContent } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { DropScope } from "@/features/explore/drop-scope"
import { MetricsTable } from "@/features/explore/metrics-table"
import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { jobFromParam, jobLabel, jobToParam } from "@/lib/core/jobs"
import { isLabelName } from "@/lib/core/promql"
import type { Snapshot } from "@/lib/core/snapshot"
import type { PrometheusResponse } from "@/lib/prometheus/types"
import { sendJson } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"

const ALL_JOBS = "__all__"
const SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "rules", label: "With rules" },
] as const

/** Names of the metrics that carry `label`, from the label-values API (cheap: no series are counted). */
function useMetricsWithLabel(label: string | null) {
  const connection = useConnection()
  const valid = label !== null && isLabelName(label)
  return useQuery({
    queryKey: ["metrics-with-label", connectionKey(connection), label],
    enabled: Boolean(connection) && valid,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const payload = await sendJson<PrometheusResponse<string[]>>(connection!, {
        path: "/api/v1/label/__name__/values",
        query: { "match[]": `{${label}!=""}` },
        signal,
      })
      if (payload.status !== "success" || !payload.data) throw new Error(payload.error ?? "Prometheus API returned an error")
      return new Set(payload.data)
    },
  })
}

function MetricsExplorer({ snapshot }: { snapshot: Snapshot }) {
  const [params, setParams] = useSearchParams()
  const query = params.get("q") ?? ""
  const jobParam = params.get("job")
  // null = all jobs; "" = series without a job label.
  const job = jobParam === null ? null : jobFromParam(jobParam)
  const scope = params.get("scope") === "rules" ? "rules" : "all"
  const label = params.get("label")
  const grouped = params.get("group") === "histograms"
  const withLabel = useMetricsWithLabel(label)
  const rules = useAppStore((state) => state.rules)
  const deferredQuery = React.useDeferredValue(query)
  const [dropScope, setDropScope] = React.useState<DropScope>("job")

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === "" || value === ALL_JOBS || (key === "scope" && value === "all")) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true }
    )

  const withRules = React.useMemo(
    () => new Set(rules.filter((rule) => rule.status !== "rejected").map((rule) => rule.selector.metric)),
    [rules]
  )

  const rows = React.useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    return snapshot.metrics.filter(
      (metric) =>
        (!needle || metric.metric.toLowerCase().includes(needle)) &&
        (job === null || metric.jobs?.includes(job) || metric.topJob === job) &&
        (scope === "all" || withRules.has(metric.metric)) &&
        (label === null || !withLabel.data || withLabel.data.has(metric.metric))
    )
  }, [snapshot, deferredQuery, job, scope, withRules, label, withLabel.data])

  return (
    <Page>
      <PageHeader
        title="Metrics"
        description={`${formatNumber(snapshot.metricCount)} metrics, sorted by active series. Open one to see which labels drive its cardinality.`}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <InputGroup className="sm:max-w-sm">
          <InputGroupInput placeholder="Filter by name…" value={query} onChange={(event) => update({ q: event.target.value })} />
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <InputGroupText>{formatNumber(rows.length)}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <div className="flex items-center gap-2">
          <Select value={jobParam ?? ALL_JOBS} onValueChange={(value) => update({ job: value })}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-56 sm:flex-none">
              <SelectValue placeholder="All jobs" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL_JOBS}>All jobs</SelectItem>
                {snapshot.jobs.map((item) => (
                  <SelectItem key={item.job} value={jobToParam(item.job)}>
                    {jobLabel(item.job)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <SegmentedControl aria-label="Show metrics" value={scope} onValueChange={(value) => update({ scope: value })} options={SCOPE_OPTIONS} className="shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="group-histograms" size="sm" checked={grouped} onCheckedChange={(checked) => update({ group: checked ? "histograms" : null })} />
          <Label htmlFor="group-histograms" className="text-sm font-normal whitespace-nowrap text-muted-foreground">
            Group histograms
          </Label>
          <Link
            to={paths.histograms}
            className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Bucket savings
          </Link>
        </div>
        {job !== null ? (
          <div className="sm:ml-auto">
            <DropScopeToggle value={dropScope} onChange={setDropScope} job={job} />
          </div>
        ) : null}
      </div>
      {label !== null ? (
        <div className="-mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-frame-border bg-frame pr-1 pl-2.5 text-foreground shadow-xs">
            <TagIcon className="size-3.5 text-muted-foreground" />
            <span>
              Has label <span className="font-mono text-xs">{label}</span>
            </span>
            {withLabel.isFetching ? <Spinner className="size-3" /> : null}
            <button
              type="button"
              aria-label={`Remove the ${label} label filter`}
              onClick={() => update({ label: null })}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-well hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </span>
          {withLabel.error || (label !== null && !isLabelName(label)) ? <span>Couldn't look up which metrics carry this label; showing all.</span> : null}
        </div>
      ) : null}
      <Card className="overflow-visible">
        <CardContent>
          {rows.length ? (
            <MetricsTable
              rows={rows}
              job={job ?? undefined}
              scope={dropScope}
              resetKey={JSON.stringify([deferredQuery, jobParam, scope, label])}
              stickyHeader
              groupHistograms={grouped}
              keyboard
            />
          ) : (
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="No matching metrics"
              description={
                scope === "rules"
                  ? "No metric with rules matches. Try All, or a different name or job."
                  : label !== null
                    ? "No metric matches with this label. Remove the label filter or try a different name or job."
                    : "Try a different name or job."
              }
            />
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

export function MetricsPage() {
  return <RequireSnapshot>{(snapshot) => <MetricsExplorer snapshot={snapshot} />}</RequireSnapshot>
}
