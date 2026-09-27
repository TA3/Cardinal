import * as React from "react"
import { DotsThreeIcon, FileTextIcon } from "@phosphor-icons/react"
import { useParams } from "react-router"

import { CodeBlock } from "@/components/code-block"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { DropScopeToggle } from "@/components/rule-parts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { DropScope } from "@/features/explore/drop-scope"
import { MetricsTable } from "@/features/explore/metrics-table"
import { OwnerBadge } from "@/features/attribution/owner-badge"
import { useJobOwners } from "@/features/attribution/use-attribution"
import { cacheDrilldownFor, useConnection, useJobDrilldown } from "@/hooks/use-cardinality"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { runWithConcurrency } from "@/lib/core/concurrency"
import { jobFromParam, jobLabel } from "@/lib/core/jobs"
import { buildPromptDataForJob, generateAIPrompt } from "@/lib/dashboard/prompt"
import type { Snapshot } from "@/lib/core/snapshot"
import type { JobDrilldownResponse } from "@/lib/prometheus/types"
import { fetchMetricDrilldown } from "@/lib/sources/prometheus"
import { useAppStore } from "@/lib/store/app-store"

function DashboardPromptDialog({ job, drilldown }: { job: string; drilldown: JobDrilldownResponse }) {
  const connection = useConnection()
  const [open, setOpen] = React.useState(false)
  const [prompt, setPrompt] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function generate() {
    if (!connection) return
    setOpen(true)
    setPending(true)
    try {
      const cached = useAppStore.getState().drilldowns
      const missing = drilldown.metrics.slice(0, 20).map((row) => row.metric).filter((metric) => !cached[metric])
      const fetched = await runWithConcurrency(missing, (metric) => fetchMetricDrilldown(connection, metric).catch(() => null), 4)
      for (const row of fetched) if (row) cacheDrilldownFor(connection, row)
      setPrompt(generateAIPrompt(buildPromptDataForJob(drilldown, useAppStore.getState().drilldowns, 20), { job }))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="More actions for this job">
            <DotsThreeIcon data-icon="inline-start" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onSelect={() => void generate()}>
            <FileTextIcon />
            Grafana dashboard prompt
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Dashboard prompt for {jobLabel(job)}</DialogTitle>
            <DialogDescription>Paste into an AI assistant to draft a Grafana dashboard for this job's metrics.</DialogDescription>
          </DialogHeader>
          {pending || !prompt ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Reading label structure of the top metrics…
            </div>
          ) : (
            <CodeBlock code={prompt} maxHeight="max-h-[60svh]" />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function JobDetail({ job, snapshot }: { job: string; snapshot: Snapshot }) {
  const { data, isPending, error } = useJobDrilldown(job)
  const summary = snapshot.jobs.find((item) => item.job === job)
  const owners = useJobOwners()
  const [scope, setScope] = React.useState<DropScope>("job")

  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <Badge variant="outline">Job</Badge>
            <OwnerBadge owners={owners?.get(job)} />
          </>
        }
        title={jobLabel(job)}
        description={
          summary
            ? `${formatNumber(summary.seriesCount)} series (${summary.percentageOfTotal.toFixed(1)}% of all) across ${formatNumber(summary.metricCount)} metrics.`
            : job === ""
              ? "Series that have no job label."
              : "Not in the current snapshot."
        }
        actions={data ? <DashboardPromptDialog job={job} drilldown={data} /> : null}
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load this job</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
          <CardDescription>Share is relative to this job. Drops made here apply to this job unless you pick all jobs.</CardDescription>
          <CardAction>
            <DropScopeToggle value={scope} onChange={setScope} job={job} />
          </CardAction>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-8" />
              ))}
            </div>
          ) : data ? (
            <MetricsTable rows={data.metrics} showJob={false} shareLabel="Share of job" job={job} scope={scope} resetKey={job} stickyHeader keyboard />
          ) : null}
        </CardContent>
      </Card>
    </Page>
  )
}

export function JobDetailPage() {
  const params = useParams()
  const job = jobFromParam(params["*"] ?? "")
  return <RequireSnapshot>{(snapshot) => <JobDetail key={job} job={job} snapshot={snapshot} />}</RequireSnapshot>
}
