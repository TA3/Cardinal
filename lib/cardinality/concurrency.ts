export async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 10
): Promise<R[]> {
  const normalizedConcurrency = Math.max(1, Math.min(20, concurrency))
  const results = new Array<R>(items.length)
  let current = 0

  async function runner() {
    while (current < items.length) {
      const index = current
      current += 1
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedConcurrency, items.length) }, () =>
      runner()
    )
  )

  return results
}
