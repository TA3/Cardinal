/**
 * Copies text, falling back to execCommand where the async clipboard API is
 * unavailable (plain-http LAN access is not a secure context).
 */
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed")
  } finally {
    area.remove()
  }
}
