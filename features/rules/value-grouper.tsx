import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BracketsCurlyIcon,
  CheckIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
  StackIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react"
import { AnimatePresence, motion } from "motion/react"

import { spring } from "@/components/motion"
import { SegmentedControl } from "@/components/segmented-control"
import { Tip } from "@/components/tip"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { formatNumber } from "@/lib/cardinality/dashboard-helpers"
import { fullMatch, regexProblem } from "@/lib/core/regex"
import {
  groupOf,
  groupOutcome,
  literalValues,
  suggestGroups,
  valuesRegex,
  type ValueCount,
  type ValueGroup,
} from "@/lib/core/value-groups"
import { cn } from "@/lib/utils"

// A controlled editor that folds a label's values into a few groups. Values
// can be picked (click, shift-click for a range) or matched with a regex;
// each group is a name plus the regex it takes in. It knows nothing about
// rules: `GroupValuesForm` wraps it with the aggregation and saving.

export interface GroupingDraft {
  groups: ValueGroup[]
  /** Set: values no group takes become this value. Unset: they keep their own value. */
  rest?: string
}

// Mid-lightness hues that read on both the light and the dark well.
const PALETTE = [
  "oklch(0.68 0.16 35)",
  "oklch(0.64 0.13 250)",
  "oklch(0.66 0.13 155)",
  "oklch(0.62 0.15 305)",
  "oklch(0.74 0.13 85)",
  "oklch(0.66 0.11 200)",
  "oklch(0.66 0.16 0)",
  "oklch(0.70 0.14 125)",
]
const REST_COLOR = "color-mix(in oklch, var(--muted-foreground) 55%, transparent)"

export const groupColor = (index: number | null) => (index === null ? "transparent" : index === -1 ? REST_COLOR : PALETTE[index % PALETTE.length])

/** A name for values picked together: `200, 204` → `2xx`, `api-a, api-b` → `api-*`. */
export function suggestName(values: string[]) {
  const named = values.filter(Boolean)
  if (named.length === 0) return "group"
  if (named.length === 1) return named[0]
  if (named.every((value) => /^\d+$/.test(value) && value.length === named[0].length)) {
    let prefix = ""
    while (prefix.length < named[0].length && named.every((value) => value[prefix.length] === named[0][prefix.length])) {
      prefix += named[0][prefix.length]
    }
    if (prefix) return prefix.padEnd(named[0].length, "x")
  }
  let prefix = named[0]
  for (const value of named) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1)
  prefix = prefix.replace(/[-_./:]+$/, "")
  return prefix.length >= 2 ? `${prefix}-*` : "group"
}

/** True when the group is a plain list of values (shown as chips) rather than a pattern. */
const literalsOf = (group: ValueGroup) => literalValues(group.regex)

export function ValueGrouper({
  label,
  values,
  seriesCount,
  value,
  onChange,
}: {
  label: string
  /** The sampled top values, largest first. */
  values: ValueCount[]
  /** All series of the metric, for shares. */
  seriesCount: number
  value: GroupingDraft
  onChange: (next: GroupingDraft) => void
}) {
  const { groups, rest } = value
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [anchor, setAnchor] = React.useState<number | null>(null)
  const [query, setQuery] = React.useState("")
  const [focusGroup, setFocusGroup] = React.useState<number | null>(null)
  const [rawEdit, setRawEdit] = React.useState<Set<number>>(new Set())
  const queryId = React.useId()

  const queryProblem = query ? regexProblem(query) : null
  const matches = React.useMemo(
    () => (query && !queryProblem ? values.filter((item) => fullMatch(query, item.value)).map((item) => item.value) : []),
    [query, queryProblem, values]
  )
  const assigned = React.useMemo(() => values.map((item) => groupOf(item.value, groups, rest)), [values, groups, rest])
  const outcome = React.useMemo(() => groupOutcome(values, groups, rest), [values, groups, rest])
  const suggestions = React.useMemo(() => suggestGroups(values), [values])
  const sampled = values.reduce((sum, item) => sum + item.seriesCount, 0)
  const selectedSeries = values.filter((item) => selected.has(item.value)).reduce((sum, item) => sum + item.seriesCount, 0)

  const set = (patch: Partial<GroupingDraft>) => onChange({ groups, rest, ...patch })
  const setGroups = (next: ValueGroup[]) => set({ groups: next })
  const updateGroup = (index: number, patch: Partial<ValueGroup>) => setGroups(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)))

  /**
   * Picked values go into one literal group: taken out of other literal
   * groups (emptied ones disappear) and placed before the first pattern
   * group, so an explicit pick beats a broader regex.
   */
  function addLiteral(picked: string[], into?: number) {
    const pickedSet = new Set(picked)
    let target = into
    const next: Array<ValueGroup | null> = groups.map((group, index) => {
      const literals = literalsOf(group)
      if (index === into) return { ...group, regex: valuesRegex([...(literals ?? []), ...picked]) }
      if (!literals || !literals.some((item) => pickedSet.has(item))) return group
      const left = literals.filter((item) => !pickedSet.has(item))
      return left.length ? { ...group, regex: valuesRegex(left) } : null
    })
    if (into === undefined) {
      const firstPattern = next.findIndex((group) => group && !literalsOf(group))
      const at = firstPattern === -1 ? next.length : firstPattern
      next.splice(at, 0, { name: suggestName(picked), regex: valuesRegex(picked) })
      target = at
    }
    // Indexes shift when emptied groups go.
    const kept = next.map((group, index) => ({ group, index })).filter((item) => item.group)
    setGroups(kept.map((item) => item.group!))
    if (into === undefined && target !== undefined) setFocusGroup(kept.findIndex((item) => item.index === target))
    setSelected(new Set())
    setAnchor(null)
  }

  function addPattern() {
    if (!query || queryProblem) return
    setGroups([...groups, { name: suggestName(matches), regex: query }])
    setFocusGroup(groups.length)
    setQuery("")
  }

  function removeGroup(index: number) {
    setGroups(groups.filter((_, i) => i !== index))
    setRawEdit(new Set())
  }

  function moveGroup(index: number, step: -1 | 1) {
    const to = index + step
    if (to < 0 || to >= groups.length) return
    const next = [...groups]
    ;[next[index], next[to]] = [next[to], next[index]]
    setGroups(next)
    setRawEdit(new Set())
  }

  function removeValue(index: number, item: string) {
    const left = (literalsOf(groups[index]) ?? []).filter((value) => value !== item)
    if (left.length) updateGroup(index, { regex: valuesRegex(left) })
    else removeGroup(index)
  }

  function toggle(index: number, event: React.MouseEvent) {
    const item = values[index].value
    setSelected((previous) => {
      const next = new Set(previous)
      if (event.shiftKey && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
        for (const row of values.slice(from, to + 1)) next.add(row.value)
      } else if (next.has(item)) next.delete(item)
      else next.add(item)
      return next
    })
    if (!event.shiftKey) setAnchor(index)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {suggestions.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <SparkleIcon className="size-3.5 text-brand" weight="fill" aria-hidden />
            Try
          </span>
          {suggestions.map((suggestion) => (
            <Tip key={suggestion.id} label={suggestion.description}>
              <button
                type="button"
                onClick={() => {
                  onChange({ groups: suggestion.groups, rest: suggestion.rest })
                  setSelected(new Set())
                  setRawEdit(new Set())
                }}
                className="inline-flex h-6 items-center rounded-full border border-dashed border-brand/40 px-2.5 text-xs text-brand-ink transition-colors outline-none hover:border-solid hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {suggestion.title}
              </button>
            </Tip>
          ))}
        </div>
      ) : null}

      {/* Pick by pattern: matches light up in the list below. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <label htmlFor={queryId} className="sr-only">
              Match {label} values with a regex
            </label>
            <Input
              id={queryId}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addPattern()
                if (event.key === "Escape") setQuery("")
              }}
              placeholder={`Match ${label} values with a regex`}
              spellCheck={false}
              aria-invalid={Boolean(queryProblem)}
              className="h-8 rounded-full pl-8 font-mono text-xs"
            />
          </div>
          <Button size="sm" variant="outline" disabled={!query || Boolean(queryProblem)} onClick={addPattern}>
            <BracketsCurlyIcon data-icon="inline-start" />
            Group pattern
          </Button>
        </div>
        {query ? (
          <p className={cn("px-3 text-[11px]", queryProblem ? "text-destructive" : "text-muted-foreground")}>
            {queryProblem
              ? `Not a usable regex: ${queryProblem}.`
              : `${matches.length} of the top ${values.length} match now; the pattern also takes in values that appear later.`}
            {matches.length && !queryProblem ? (
              <button
                type="button"
                className="ml-1.5 text-brand-ink hover:underline"
                onClick={() => setSelected((previous) => new Set([...previous, ...matches]))}
              >
                Select them
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* The values: click to select, shift-click for a range. */}
      <div role="listbox" aria-multiselectable aria-label={`Top values of ${label}`} className="gap-x-4 sm:columns-2">
        {values.map((item, index) => {
          const group = assigned[index]
          const on = selected.has(item.value)
          const hit = matches.includes(item.value)
          const name = group === null ? null : group === -1 ? rest : groups[group]?.name
          return (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={on}
              onClick={(event) => toggle(index, event)}
              className={cn(
                "group/value relative flex w-full min-w-0 break-inside-avoid items-center gap-2 rounded-md py-1 pr-1.5 pl-2 text-left text-xs outline-none select-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                on && "bg-foreground/[0.06] hover:bg-foreground/[0.08]",
                hit && !on && "bg-brand/[0.07]"
              )}
            >
              <span
                className="absolute inset-y-1 left-0 w-[3px] rounded-full transition-colors"
                style={{ background: groupColor(group) }}
                aria-hidden
              />
              <span
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                  on ? "border-foreground bg-foreground text-background" : "border-foreground/25 group-hover/value:border-foreground/50"
                )}
                aria-hidden
              >
                {on ? <CheckIcon className="size-2.5" weight="bold" /> : null}
              </span>
              <span className={cn("min-w-0 flex-1 truncate font-mono", group !== null && "text-muted-foreground")}>
                {item.value || <em>empty</em>}
              </span>
              {name ? (
                <span className="flex max-w-[45%] shrink-0 items-center gap-1 truncate font-mono text-[11px] text-foreground">
                  <span aria-hidden className="text-muted-foreground">→</span>
                  <span className="truncate">{name}</span>
                </span>
              ) : (
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(item.seriesCount)}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Selection bar: appears once something is picked. */}
      <AnimatePresence initial={false}>
        {selected.size ? (
          <motion.div
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            transition={spring}
            className="sticky bottom-2 z-10 flex flex-wrap items-center gap-1.5 self-start rounded-full bg-foreground py-1 pr-1 pl-3 text-xs text-background shadow-lg"
          >
            <span className="tabular-nums">
              {selected.size} selected · {formatNumber(selectedSeries)} series
            </span>
            <Button size="xs" className="bg-background text-foreground hover:bg-background/90" onClick={() => addLiteral(Array.from(selected))}>
              <PlusIcon data-icon="inline-start" />
              New group
            </Button>
            {groups.some((group) => literalsOf(group)) ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="ghost" className="text-background hover:bg-background/15 hover:text-background">
                    Add to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuLabel className="text-xs">Add to group</DropdownMenuLabel>
                  {groups.map((group, index) =>
                    literalsOf(group) ? (
                      <DropdownMenuItem key={index} onSelect={() => addLiteral(Array.from(selected), index)}>
                        <span className="size-2 rounded-full" style={{ background: groupColor(index) }} aria-hidden />
                        <span className="truncate font-mono text-xs">{group.name || "unnamed"}</span>
                      </DropdownMenuItem>
                    ) : null
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear the selection"
              className="text-background hover:bg-background/15 hover:text-background"
              onClick={() => setSelected(new Set())}
            >
              <XIcon />
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* The groups, in match order. */}
      {groups.length ? (
        <ol className="flex flex-col gap-1.5" aria-label="Groups">
          <AnimatePresence initial={false}>
            {groups.map((group, index) => {
              const literals = literalsOf(group)
              const raw = !literals || rawEdit.has(index)
              const problem = group.regex ? regexProblem(group.regex) : "empty"
              const row = outcome.find((item) => item.group === index)
              const count = values.filter((_, i) => assigned[i] === index)
              return (
                <motion.li
                  key={index}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={spring}
                  className="flex items-start gap-2 rounded-xl border border-well-border bg-background/60 p-2"
                >
                  <span className="mt-2 size-2.5 shrink-0 rounded-full" style={{ background: groupColor(index) }} aria-hidden />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Input
                        value={group.name}
                        autoFocus={focusGroup === index}
                        onFocus={(event) => {
                          if (focusGroup === index) {
                            event.target.select()
                            setFocusGroup(null)
                          }
                        }}
                        onChange={(event) => updateGroup(index, { name: event.target.value })}
                        aria-label={`Name of group ${index + 1}`}
                        aria-invalid={!group.name.trim()}
                        placeholder="name"
                        spellCheck={false}
                        className="h-7 max-w-56 border-transparent bg-transparent px-1.5 font-mono text-xs font-medium shadow-none hover:border-input focus-visible:border-input"
                      />
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {count.length} value{count.length === 1 ? "" : "s"}
                        {row ? ` · ${formatNumber(row.seriesCount)} series` : ""}
                      </span>
                    </div>
                    {raw ? (
                      <div className="flex flex-col gap-0.5">
                        <Input
                          value={group.regex}
                          onChange={(event) => updateGroup(index, { regex: event.target.value })}
                          aria-label={`Pattern of group ${group.name || index + 1}`}
                          aria-invalid={Boolean(problem)}
                          spellCheck={false}
                          className="h-7 font-mono text-xs"
                        />
                        {problem ? (
                          <span className="px-1 text-[11px] text-destructive">{problem === "empty" ? "Matches nothing yet." : `Not a usable regex: ${problem}.`}</span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {literals!.map((item) => (
                          <span
                            key={item}
                            className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-full border border-border bg-background pr-0.5 pl-2 font-mono text-[11px]"
                          >
                            <span className="truncate">{item || "empty"}</span>
                            <button
                              type="button"
                              aria-label={`Take ${item} out of ${group.name}`}
                              onClick={() => removeValue(index, item)}
                              className="flex size-4.5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              <XIcon className="size-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-xs" variant="ghost" aria-label={`Actions for ${group.name || `group ${index + 1}`}`} className="mt-0.5">
                        <DotsThreeIcon weight="bold" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {literals ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            setRawEdit((previous) => {
                              const next = new Set(previous)
                              if (next.has(index)) next.delete(index)
                              else next.add(index)
                              return next
                            })
                          }
                        >
                          <BracketsCurlyIcon />
                          {rawEdit.has(index) ? "Show as values" : "Edit as regex"}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem disabled={index === 0} onSelect={() => moveGroup(index, -1)}>
                        <ArrowUpIcon />
                        Match earlier
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={index === groups.length - 1} onSelect={() => moveGroup(index, 1)}>
                        <ArrowDownIcon />
                        Match later
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => removeGroup(index)}>
                        <TrashIcon />
                        Remove group
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed border-well-border px-3 py-4 text-center text-xs text-muted-foreground">
          Select values above and press <span className="font-medium text-foreground">New group</span>, or match them with a pattern.
        </p>
      )}

      {/* Everything no group takes. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Other values</span>
        <SegmentedControl
          size="sm"
          aria-label="What happens to values no group takes"
          value={rest === undefined ? "keep" : "fold"}
          onValueChange={(next) => set({ rest: next === "keep" ? undefined : "other" })}
          options={[
            { value: "keep", label: "Keep as they are" },
            { value: "fold", label: "Fold into one" },
          ]}
        />
        {rest !== undefined ? (
          <Input
            value={rest}
            onChange={(event) => set({ rest: event.target.value })}
            aria-label="Value for everything else"
            aria-invalid={!rest.trim()}
            spellCheck={false}
            className="h-7 w-28 font-mono text-xs"
          />
        ) : null}
      </div>

      <OutcomeBar outcome={outcome} sampled={sampled} seriesCount={seriesCount} before={values.length} />
    </div>
  )
}

/** Before → after: the output values as a stacked bar of their series share. */
function OutcomeBar({
  outcome,
  sampled,
  seriesCount,
  before,
}: {
  outcome: ReturnType<typeof groupOutcome>
  sampled: number
  seriesCount: number
  before: number
}) {
  const grouped = outcome.filter((row) => row.group !== null)
  const kept = outcome.length - grouped.length
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5">
          <StackIcon className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="tabular-nums">
            <span className="font-medium">{before}</span> values <span className="text-muted-foreground">→</span>{" "}
            <span className="font-medium">{outcome.length}</span>
          </span>
          {kept ? <span className="text-muted-foreground">({kept} kept as is)</span> : null}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          top values hold {((sampled / Math.max(1, seriesCount)) * 100).toFixed(0)}% of series
        </span>
      </div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-foreground/5" role="img" aria-label="Series share of each output value">
        {outcome.map((row) => (
          <motion.span
            key={row.name}
            layout
            transition={spring}
            title={`${row.name}: ${formatNumber(row.seriesCount)} series`}
            className="h-full min-w-px"
            style={{
              flexGrow: row.seriesCount || 1,
              background: row.group === null ? "color-mix(in oklch, var(--foreground) 14%, transparent)" : groupColor(row.group),
            }}
          />
        ))}
      </div>
    </div>
  )
}
