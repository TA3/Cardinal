import * as React from "react"
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react"

import { cn } from "@/lib/utils"

// Shared motion vocabulary. Things arrive by un-blurring (not sliding far),
// values swap with a short blur, and springs are soft with little bounce.

export const spring = { type: "spring", bounce: 0.15, duration: 0.5 } as const
export const softSpring = { type: "spring", bounce: 0.25, duration: 0.45 } as const

const revealVariants = {
  hidden: { opacity: 0, filter: "blur(4px)", y: 4 },
  visible: { opacity: 1, filter: "blur(0px)", y: 0, transition: { duration: 0.4, ease: "easeInOut" } },
} as const

/** Container that reveals its <Reveal> children one after another. */
export function Stagger({ className, delay = 0, step = 0.05, ...props }: HTMLMotionProps<"div"> & { delay?: number; step?: number }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: step, delayChildren: delay } } }}
      {...props}
    />
  )
}

export function Reveal({ className, ...props }: HTMLMotionProps<"div">) {
  return <motion.div className={cn("min-w-0", className)} variants={revealVariants} {...props} />
}

/** Standalone blur-in for content that loads later than its container. */
export function FadeIn({ className, delay = 0, ...props }: HTMLMotionProps<"div"> & { delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, filter: "blur(4px)", y: 3 }}
      animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
      transition={{ duration: 0.4, ease: "easeInOut", delay }}
      {...props}
    />
  )
}

/** Swaps text with a short blur when the value changes. */
export function SwapText({ value, className }: { value: React.ReactNode; className?: string }) {
  const key = typeof value === "string" || typeof value === "number" ? String(value) : undefined
  return (
    <span className={cn("relative inline-flex", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={key}
          initial={{ opacity: 0, filter: "blur(2px)", y: 3 }}
          animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
          exit={{ opacity: 0, filter: "blur(2px)", y: -3 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="inline-block whitespace-nowrap"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/** A number that eases towards its new value. */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString(), className }: { value: number; format?: (value: number) => string; className?: string }) {
  const [display, setDisplay] = React.useState(value)
  const from = React.useRef(value)

  React.useEffect(() => {
    const start = performance.now()
    const initial = from.current
    const duration = 600
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = initial + (value - initial) * eased
      setDisplay(next)
      from.current = next
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value])

  return <span className={cn("tabular-nums", className)}>{format(display)}</span>
}

/** Status dot in the current text colour; pulses while live. */
export function LiveDot({ className, pulse = true }: { className?: string; pulse?: boolean }) {
  return (
    <span aria-hidden className={cn("relative flex size-2 shrink-0", className)}>
      {pulse ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-50" /> : null}
      <span className="relative inline-flex size-full rounded-full bg-current" />
    </span>
  )
}

/** Height-animated disclosure for lists that expand in place. */
export function Expand({ open, children, className }: { open: boolean; children: React.ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={spring}
          className={cn("overflow-hidden", className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
