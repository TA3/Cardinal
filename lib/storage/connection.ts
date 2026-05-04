"use client"

import { PrometheusConnectionInput } from "@/lib/prometheus/types"

const STORAGE_KEY = "cardinal.prometheus.connection"

export interface StoredConnection {
  baseUrl: string
  instanceId?: string
  token?: string
  remember: boolean
  proxyMode?: boolean
}

export function getStoredConnection(): StoredConnection | null {
  if (typeof window === "undefined") {
    return null
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as StoredConnection
    if (!parsed.baseUrl) {
      return null
    }
    return {
      ...parsed,
      instanceId: parsed.instanceId ?? "",
      token: parsed.token ?? "",
      proxyMode: parsed.proxyMode ?? false,
    }
  } catch {
    return null
  }
}

export function saveStoredConnection(connection: StoredConnection) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(connection))
}

export function clearStoredConnection() {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.removeItem(STORAGE_KEY)
}

export function toPrometheusConnection(
  input: StoredConnection
): PrometheusConnectionInput {
  const instanceId = input.instanceId?.trim() ?? ""
  const token = input.token ?? ""

  return {
    baseUrl: input.baseUrl.trim(),
    instanceId: instanceId || undefined,
    token: token || undefined,
  }
}
