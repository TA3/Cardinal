const DEFAULT_CONCURRENCY = 10

/**
 * Runs `worker` over `items` with bounded concurrency. Stops pulling new items
 * after the first failure or once `signal` aborts, and rejects with that error.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = DEFAULT_CONCURRENCY,
  signal?: AbortSignal
): Promise<R[]> {
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.min(20, Math.floor(concurrency))) : DEFAULT_CONCURRENCY
  const results = new Array<R>(items.length)
  let current = 0
  let failed = false

  async function runner() {
    while (!failed && current < items.length) {
      signal?.throwIfAborted()
      const index = current
      current += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }

  signal?.throwIfAborted()
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()))
  signal?.throwIfAborted()
  return results
}

/**
 * Caps how many calls of `fn`-style work run at once across callers (e.g.
 * measurements started by hovering table rows). Queued work starts in order.
 */
export function createLimiter(limit: number) {
  const max = Math.max(1, Math.floor(limit) || 1)
  let running = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (running >= max) return
    const start = queue.shift()
    if (start) {
      running += 1
      start()
    }
  }
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            running -= 1
            next()
          })
      })
      next()
    })
  }
}
