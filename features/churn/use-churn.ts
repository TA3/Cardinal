import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { connectionKey, useConnection } from "@/hooks/use-cardinality"
import type { ChurnWindow } from "@/lib/core/churn"
import { fetchChurn, fetchLabelDrivers, type ChurnProgress } from "@/lib/sources/churn"
import { useAppStore } from "@/lib/store/app-store"

// Churn data for the page and the Overview card. Both share one query per
// window, so the card reuses what the page loaded and the other way round.

const progress = new Map<string, ChurnProgress | null>()
const listeners = new Set<() => void>()

function setProgress(key: string, value: ChurnProgress | null) {
  progress.set(key, value)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Progress of the running churn measurement for `key`, or null. */
function useProgress(key: string) {
  return React.useSyncExternalStore(subscribe, () => progress.get(key) ?? null)
}

export function useChurn(window: ChurnWindow, enabled = true) {
  const connection = useConnection()
  const jobs = useAppStore((state) => state.snapshot?.jobs)
  const key = connectionKey(connection)
  const progressKey = `churn:${key}:${window}`
  const query = useQuery({
    queryKey: ["churn", key, window],
    enabled: Boolean(connection) && enabled,
    queryFn: async ({ signal }) => {
      const log = useAppStore.getState().log
      try {
        return await fetchChurn(connection!, window, {
          signal,
          jobs: jobs?.map((job) => job.job),
          onProgress: log,
          onStep: (step) => setProgress(progressKey, step),
        })
      } finally {
        setProgress(progressKey, null)
      }
    },
    retry: false,
    staleTime: 5 * 60_000,
  })
  return { ...query, progress: useProgress(progressKey) }
}

export function useLabelDrivers(metric: string, job: string | undefined, window: ChurnWindow, enabled: boolean) {
  const connection = useConnection()
  const key = connectionKey(connection)
  const progressKey = `drivers:${key}:${window}:${metric}:${job ?? "\u0000"}`
  const query = useQuery({
    queryKey: ["churn-drivers", key, window, metric, job ?? null],
    enabled: Boolean(connection) && enabled,
    queryFn: async ({ signal }) => {
      try {
        return await fetchLabelDrivers(connection!, metric, window, { job, signal, onStep: (step) => setProgress(progressKey, step) })
      } finally {
        setProgress(progressKey, null)
      }
    },
    retry: false,
    staleTime: 5 * 60_000,
  })
  return { ...query, progress: useProgress(progressKey) }
}
