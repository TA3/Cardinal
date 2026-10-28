import { ArrowUpRightIcon, GithubLogoIcon } from "@phosphor-icons/react"

import { LogoMark } from "@/components/logo"

const external = { target: "_blank", rel: "noopener" } as const

/** Quiet sign-off under every page: the name, the year, the source, and a sibling project. */
export function Footer() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-8 sm:px-6">
      <div className="flex flex-col gap-3 border-t border-frame-border pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2">
          <LogoMark className="size-4" />
          <span>Cardinal © {new Date().getFullYear()}</span>
          <a
            href="https://github.com/TA3/cardinal"
            {...external}
            aria-label="Cardinal on GitHub"
            className="ml-1 flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <GithubLogoIcon className="size-4" />
          </a>
        </p>
        <a
          href="https://use.observer"
          {...external}
          className="group/observer inline-flex w-fit items-center gap-1 rounded-sm text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Status pages from the same metrics: Observer
          <ArrowUpRightIcon className="size-3 opacity-60 transition-transform group-hover/observer:translate-x-0.5 group-hover/observer:-translate-y-0.5" />
        </a>
      </div>
    </footer>
  )
}
