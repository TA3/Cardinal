// Byte sizes for logs volume. Units are 1024-based (1 KB = 1,024 bytes), the
// way Loki and Grafana report ingest, and labelled KB / MB / GB / TB.

export const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const

export const BYTES_PER_GB = 1024 ** 3

/** Says how the units are counted, for tooltips next to byte figures. */
export const BYTES_NOTE = "1 KB = 1,024 bytes, 1 GB = 1,024³ bytes"

/**
 * "1.4 GB", "812 MB", "0 B". Three significant digits at most; `digits` pins
 * the decimals instead.
 */
export function formatBytes(bytes: number, { digits }: { digits?: number } = {}) {
  if (!Number.isFinite(bytes)) return "—"
  const sign = bytes < 0 ? "−" : ""
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const decimalsFor = (n: number, u: number) => digits ?? (u === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2)
  let decimals = decimalsFor(value, unit)
  // 1023.96 KB would round to "1024 KB": carry into the next unit.
  if (Number(value.toFixed(decimals)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
    decimals = decimalsFor(Math.max(1, value), unit)
    value = Math.max(1, value)
  }
  const text = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return `${sign}${text} ${BYTE_UNITS[unit]}`
}

/** A signed change, e.g. "+1.2 GB" or "−340 MB". */
export function formatBytesDelta(bytes: number) {
  if (bytes === 0) return "0 B"
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes)
}

/** Gigabytes (1024³ bytes). */
export function toGB(bytes: number) {
  return bytes / BYTES_PER_GB
}
