import { useLocation, useNavigate } from "react-router"

import { paths } from "@/app/paths"
import { SegmentedControl } from "@/components/segmented-control"

// Explore is one tab with four views of the metrics snapshot. Each keeps its
// own route, so links and the g e / g j / g c / g h chords still land on it.

export const EXPLORE_VIEWS = [
  { value: paths.explore, label: "Metrics" },
  { value: paths.jobs, label: "Jobs" },
  { value: paths.churn, label: "Churn" },
  { value: paths.histograms, label: "Histograms" },
] as const

export type ExploreView = (typeof EXPLORE_VIEWS)[number]["value"]

/** The Explore view a metrics path belongs to, or null outside Explore. */
export function exploreViewOf(pathname: string): ExploreView | null {
  return EXPLORE_VIEWS.find(({ value }) => pathname === value || pathname.startsWith(`${value}/`))?.value ?? null
}

/** The view switcher, for the PageHeader eyebrow of each Explore page. */
export function ExploreViews() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current = exploreViewOf(pathname) ?? paths.explore
  return (
    <SegmentedControl
      aria-label="Explore view"
      size="sm"
      value={current}
      onValueChange={(view) => navigate(view)}
      options={EXPLORE_VIEWS}
    />
  )
}
