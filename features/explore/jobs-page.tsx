import * as React from "react"
import { BriefcaseIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router"

import { jobPath } from "@/app/paths"
import { EmptyState } from "@/components/empty-state"
import { Page, PageHeader } from "@/components/page"
import { RequireSnapshot } from "@/components/require-snapshot"
import { ShareBar } from "@/components/share-bar"
import { Card, CardContent } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CURSOR_ROW_CLASS, useRowCursor } from "@/components/use-row-cursor"
import { OwnerBadge } from "@/features/attribution/owner-badge"
import { useJobOwners } from "@/features/attribution/use-attribution"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { jobLabel } from "@/lib/core/jobs"
import type { Snapshot } from "@/lib/core/snapshot"
import { cn } from "@/lib/utils"

function JobsList({ snapshot }: { snapshot: Snapshot }) {
  const navigate = useNavigate()
  const owners = useJobOwners()
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const jobs = snapshot.jobs.filter((job) => jobLabel(job.job).toLowerCase().includes(needle))
  const { rowProps } = useRowCursor({
    count: jobs.length,
    resetKey: needle,
    onOpen: (index) => {
      const job = jobs[index]
      if (job) navigate(jobPath(job.job))
    },
  })

  if (snapshot.jobs.length === 0) {
    return (
      <Page>
        <PageHeader title="Jobs" description="Scrape jobs by the active series they produce." />
        <EmptyState
          framed
          icon={BriefcaseIcon}
          title="No jobs in this snapshot"
          description="The backend returned no active series. Refresh once it has scraped some data."
        />
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader title="Jobs" description="Scrape jobs by the active series they produce. A job is usually one exporter or service." />
      <InputGroup className="sm:max-w-sm">
        <InputGroupInput placeholder="Filter jobs…" aria-label="Filter jobs" value={query} onChange={(event) => setQuery(event.target.value)} />
        <InputGroupAddon>
          <MagnifyingGlassIcon />
        </InputGroupAddon>
      </InputGroup>
      <Card>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState icon={MagnifyingGlassIcon} title="No matching jobs" description={`Nothing matches “${query}”.`} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead className="text-right">Metrics</TableHead>
                  <TableHead className="text-right">Series</TableHead>
                  <TableHead className="hidden w-56 sm:table-cell">Share of all series</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job, index) => (
                  <TableRow
                    key={job.job}
                    {...rowProps(index)}
                    className={cn("animate-blur-in cursor-pointer", CURSOR_ROW_CLASS)}
                    style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
                    onClick={(event) => {
                      if (!(event.target instanceof Element && event.target.closest("a"))) navigate(jobPath(job.job))
                    }}
                  >
                    <TableCell className="max-w-0 min-w-48 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link
                          to={jobPath(job.job)}
                          title={jobLabel(job.job)}
                          className={cn(
                            "truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                            job.job === "" && "text-muted-foreground italic"
                          )}
                        >
                          {jobLabel(job.job)}
                        </Link>
                        <OwnerBadge owners={owners?.get(job.job)} hideUnattributed />
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(job.metricCount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(job.seriesCount)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <ShareBar percent={job.percentageOfTotal} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

export function JobsPage() {
  return <RequireSnapshot>{(snapshot) => <JobsList snapshot={snapshot} />}</RequireSnapshot>
}
