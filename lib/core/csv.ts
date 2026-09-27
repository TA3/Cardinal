/**
 * One CSV cell: quoted when it holds a comma, quote or line break, and
 * prefixed with ' when it starts like a formula (= + - @), which spreadsheets
 * would otherwise run.
 */
export function csvField(raw: string | number) {
  const text = String(raw)
  const value = typeof raw === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
