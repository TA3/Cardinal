import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import { createLimiter } from "@/lib/core/concurrency"
import { quantileUsage } from "@/lib/core/histograms"
import {
  fetchBucketDistribution,
  fetchClassicHistogram,
  fetchHistogramAnalysis,
  fetchRuleQueries,
} from "@/lib/sources/histograms"
import { useAppStore } from "@/lib/store/app-store"

// Histogram data for the UI, keyed by connection and snapshot. Distributions
// load per family on expand, two at a time.

const distributionLimit = createLimiter(2)

export function useHistogramAnalysis() {
  const connection = useConnection()
  const snapshot = useAppStore((state) => state.snapshot)
  return useQuery({
    queryKey: [
      "histograms",
      connectionKey(connection),
      snapshot?.capturedAt ?? null,
    ],
    enabled: Boolean(connection && snapshot),
    queryFn: ({ signal }) =>
      fetchHistogramAnalysis(connection!, snapshot!.metrics, signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** One classic family (for the metric page), without the instance-wide queries. */
export function useClassicHistogram(bucketMetric: string) {
  const connection = useConnection()
  const snapshot = useAppStore((state) => state.snapshot)
  return useQuery({
    queryKey: [
      "classic-histogram",
      connectionKey(connection),
      snapshot?.capturedAt ?? null,
      bucketMetric,
    ],
    enabled: Boolean(connection && snapshot),
    queryFn: ({ signal }) =>
      fetchClassicHistogram(
        connection!,
        snapshot!.metrics,
        bucketMetric,
        signal
      ),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useBucketDistribution(
  bucketMetric: string | undefined,
  job?: string
) {
  const connection = useConnection()
  return useQuery({
    queryKey: [
      "bucket-distribution",
      connectionKey(connection),
      bucketMetric,
      job ?? null,
    ],
    enabled: Boolean(connection && bucketMetric),
    queryFn: ({ signal }) =>
      distributionLimit(() =>
        fetchBucketDistribution(connection!, bucketMetric!, { job, signal })
      ),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Alerting/recording rule expressions; empty when the rules API is unavailable. */
export function useRuleQueries() {
  const connection = useConnection()
  return useQuery({
    queryKey: ["rule-queries", connectionKey(connection)],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => fetchRuleQueries(connection!, signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useQuantileUsage(bucketMetric: string) {
  const { data } = useRuleQueries()
  return React.useMemo(
    () => quantileUsage(data ?? [], bucketMetric),
    [data, bucketMetric]
  )
}
