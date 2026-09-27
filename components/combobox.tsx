import * as React from "react"
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ComboboxOption {
  value: string
  label?: React.ReactNode
  /** Right-aligned detail, e.g. a size. */
  detail?: React.ReactNode
  /** Extra text to search by. */
  keywords?: string[]
}

/** A searchable single choice: a pill button that opens a filterable list. */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = "Search…",
  prefix,
  mono = false,
  className,
  "aria-label": ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  /** Muted text before the value in the button, e.g. "by". */
  prefix?: React.ReactNode
  mono?: boolean
  className?: string
  "aria-label": string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} className={cn("max-w-64 justify-between", className)}>
          <span className="flex min-w-0 items-baseline gap-1.5">
            {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
            <span className={cn("truncate", mono && "font-mono text-[13px]")}>{selected?.label ?? (value || "Choose…")}</span>
          </span>
          <CaretUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={option.keywords}
                  onSelect={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <CheckIcon className={cn("size-3.5", option.value === value ? "opacity-100" : "opacity-0")} />
                  <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[13px]")}>{option.label ?? option.value}</span>
                  {option.detail ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{option.detail}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
