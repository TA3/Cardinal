import * as React from "react"
import { BookOpenIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"

import { EmptyState } from "@/components/empty-state"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { GLOSSARY, type GlossaryEntry } from "@/lib/core/glossary"

const ENTRIES: GlossaryEntry[] = [...Object.values(GLOSSARY)].sort((a, b) => a.term.localeCompare(b.term))

/** The glossary as a searchable side sheet. */
export function GlossarySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const entries = needle
    ? ENTRIES.filter((entry) => [entry.term, entry.short, entry.long].some((text) => text.toLowerCase().includes(needle)))
    : ENTRIES

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setQuery("")
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Glossary</SheetTitle>
          <SheetDescription>The terms Cardinal uses, in plain words.</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <InputGroup>
            <InputGroupInput autoFocus placeholder="Search terms…" aria-label="Search the glossary" value={query} onChange={(event) => setQuery(event.target.value)} />
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {entries.length ? (
            <dl className="flex flex-col">
              {entries.map((entry) => (
                <div key={entry.term} className="border-b border-border/60 py-3 last:border-0">
                  <dt className="text-sm font-medium">{entry.term}</dt>
                  <dd className="mt-0.5 text-sm text-muted-foreground">
                    <p className="text-foreground/85">{entry.short}</p>
                    {entry.long ? <p className="mt-1">{entry.long}</p> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <EmptyState icon={BookOpenIcon} title="No matching terms" description={ENTRIES.length ? `Nothing matches “${query}”.` : "The glossary is empty."} compact />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
