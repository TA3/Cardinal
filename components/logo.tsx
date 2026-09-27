import * as React from "react"

import { cn } from "@/lib/utils"

// A cardinal's round head with its tall, spiky crest; no beak, eye or mask.
const HEAD =
  "M13.2 1C14.5 4.4 15.8 6.6 17 8.5 18.7 10.4 19.4 12.6 19.4 14.8 19.4 18.9 16 22 11.9 22 7.8 22 4.6 18.9 4.6 14.8 4.6 12.8 5.3 11.1 6.5 9.8L3.4 8.6 7.3 7.7 5.2 3.9 9.2 5.8 9.3 1.8 11.3 4.9Z"
// The bright top-front half; the rest of the head sits in a deeper tone.
const LIT = "M0 0H24V14.4L0 7.2Z"

/**
 * Cardinal's mark: a crested cardinal head split diagonally into two tones of
 * brand orange, bright at the top front and deeper at the bottom back.
 */
export function LogoMark({ className }: { className?: string }) {
  const clip = `cardinal-mark-${React.useId().replace(/:/g, "")}`
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-7", className)}>
      <defs>
        <clipPath id={clip}>
          <path d={HEAD} />
        </clipPath>
      </defs>
      <path d={HEAD} fill="color-mix(in oklch, var(--brand) 72%, oklch(0.42 0.17 30))" />
      <path d={LIT} clipPath={`url(#${clip})`} className="fill-brand" />
    </svg>
  )
}

/** The header logo. */
export function Logo({ className }: { className?: string }) {
  return <LogoMark className={cn("size-8 shrink-0", className)} />
}
