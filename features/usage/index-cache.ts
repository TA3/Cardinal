import type { GrafanaUsageIndex } from "@/lib/core/grafana-usage"

// Scan results per Grafana URL, in IndexedDB: an index of a large Grafana is
// megabytes, too big for localStorage next to the snapshot. Every failure
// (private mode, blocked storage) degrades to "no cached scan".

const DB_NAME = "cardinal-grafana"
const STORE = "indexes"

let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function loadCachedIndex(baseUrl: string): Promise<GrafanaUsageIndex | null> {
  const index = await run("readonly", (store) => store.get(baseUrl) as IDBRequest<GrafanaUsageIndex | undefined>)
  return index && index.version === 1 ? index : null
}

export async function saveCachedIndex(index: GrafanaUsageIndex) {
  await run("readwrite", (store) => store.put(index, index.baseUrl))
}

export async function clearCachedIndexes() {
  await run("readwrite", (store) => store.clear())
}
