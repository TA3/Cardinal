import * as React from "react"
import { CaretUpDownIcon, CheckIcon, XIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { SUGGESTED_ATTRIBUTION_LABELS, attributionLabelProblem } from "@/lib/core/attribution"
import { cn } from "@/lib/utils"

interface Option {
  value: string
  hint?: string
  disabled?: boolean
}

const MAX_OPTIONS = 60

/**
 * Combobox for one attribution label: suggestions first, then the backend's
 * label names; free text is accepted when it is a valid label name.
 */
export function LabelPicker({
  id,
  value,
  onChange,
  names,
  loadingNames,
  usedBy,
  placeholder = "None",
  "aria-label": ariaLabel,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  /** The backend's label names; null while unknown. */
  names: string[] | null
  loadingNames?: boolean
  /** Labels taken by other levels, with the level's name. */
  usedBy: Record<string, string>
  placeholder?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [cursor, setCursor] = React.useState(0)
  const listId = React.useId()
  const text = query.trim()
  const problem = text ? attributionLabelProblem(text) : null

  const options = React.useMemo(() => {
    const known = names ? new Set(names) : null
    const needle = text.toLowerCase()
    const matches = (name: string) => !needle || name.toLowerCase().includes(needle)
    const make = (name: string, hint?: string): Option => ({
      value: name,
      hint: usedBy[name] ? `used as ${usedBy[name]}` : hint,
      disabled: Boolean(usedBy[name]),
    })
    const suggested = SUGGESTED_ATTRIBUTION_LABELS.filter(matches).map((name) => make(name, known && !known.has(name) ? "not found" : "suggested"))
    const rest = (names ?? []).filter((name) => matches(name) && !SUGGESTED_ATTRIBUTION_LABELS.includes(name)).map((name) => make(name))
    // Exact and prefix matches first, then suggestions that exist, then the rest.
    const rank = (option: Option) =>
      (needle && option.value.toLowerCase() === needle ? 0 : needle && option.value.toLowerCase().startsWith(needle) ? 1 : 2) * 2 +
      Number(option.hint === "not found")
    const list: Option[] = [...suggested, ...rest]
      .map((option, index) => ({ option, index }))
      .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
      .map(({ option }) => option)
      .slice(0, MAX_OPTIONS)
    if (text && !problem && !list.some((option) => option.value === text)) {
      const typed = { value: text, hint: usedBy[text] ? `used as ${usedBy[text]}` : known ? "not found, use anyway" : "use this label", disabled: Boolean(usedBy[text]) }
      // A name the backend doesn't list goes last; without the list it is the best guess.
      if (known) list.push(typed)
      else list.unshift(typed)
    }
    return list
  }, [names, text, problem, usedBy])

  // The highlighted option, skipping disabled ones.
  const active = options[cursor] && !options[cursor].disabled ? cursor : options.findIndex((option) => !option.disabled)

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  const move = (delta: number) => {
    if (!options.length) return
    let next = active < 0 ? 0 : active
    for (let step = 0; step < options.length; step += 1) {
      next = (next + delta + options.length) % options.length
      if (!options[next].disabled) break
    }
    setCursor(next)
    document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
        setCursor(0)
      }}
    >
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} className="w-full justify-between font-normal">
          <span className={cn("truncate", value ? "font-mono text-[13px]" : "text-muted-foreground")}>{value || placeholder}</span>
          <CaretUpDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-60 p-1">
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              move(1)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              move(-1)
            } else if (event.key === "Enter") {
              event.preventDefault()
              const option = options[active]
              if (option && !option.disabled) pick(option.value)
            }
          }}
          placeholder="Search or type a label name"
          aria-label="Label name"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={problem ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-lg border border-input/40 bg-input/30 px-2.5 font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive"
        />
        {problem ? <p className="px-2 pt-1.5 text-xs text-destructive">{problem}</p> : null}
        <ul id={listId} role="listbox" aria-label="Label names" className="mt-1 max-h-64 overflow-y-auto">
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              onPointerMove={() => !option.disabled && setCursor(index)}
              onClick={() => !option.disabled && pick(option.value)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                index === active && "bg-muted",
                option.disabled && "opacity-50"
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{option.value}</span>
              {option.hint ? <span className="shrink-0 text-xs text-muted-foreground">{option.hint}</span> : null}
              <CheckIcon className={cn("size-3.5 shrink-0", option.value === value ? "opacity-100" : "opacity-0")} />
            </li>
          ))}
          {loadingNames ? (
            <li className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Reading label names…
            </li>
          ) : null}
          {!options.length && !loadingNames ? <li className="px-2 py-3 text-center text-xs text-muted-foreground">No matching labels</li> : null}
        </ul>
        {value ? (
          <button
            type="button"
            onClick={() => pick("")}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border/60 px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted"
          >
            <XIcon className="size-3.5" />
            Clear
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
