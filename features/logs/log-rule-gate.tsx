import * as React from "react"
import { ShieldCheckIcon, ShieldWarningIcon } from "@phosphor-icons/react"

import { SegmentedControl } from "@/components/segmented-control"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { EvidenceList } from "@/features/rules/drop-gate"
import { useLogUsageSummary } from "@/features/rules/log-usage"
import { Term } from "@/features/rules/term"
import { guardedLogLabel } from "@/lib/core/logs/label-advice"
import { logRuleTarget } from "@/lib/core/logs/logql-usage"
import { describeLogRule, keepCoversAll, LINE_REMOVING_KINDS, MAX_RATIONALE } from "@/lib/core/logs/rules"
import { lineRegexProblem, renderSelector, selectorKey, selectorsDisjoint } from "@/lib/core/logs/selector"
import type { LineFilter, LogRule, StreamSelector } from "@/lib/core/logs/types"
import { useAppStore } from "@/lib/store/app-store"

// The check before a log rule becomes active, like the metrics DropGate: where
// the streams are read (Loki rules, LogQL dashboards), what wasn't checked,
// keep rules that protect some of the lines, a guard with an explicit override
// for labels everything relies on, and the sample rate, line filter or (for a
// keep) the reason, for the kinds that need one.

export type LogToggleKind = "drop_streams" | "drop_label" | "label_to_metadata" | "sample" | "drop_lines" | "keep"

export interface LogToggleCandidate {
  kind: LogToggleKind
  /** Empty: every stream. */
  selector: StreamSelector
  label?: string
  /** A preset line filter (e.g. from a pattern); drop_lines without one asks for levels or a regex. */
  line?: LineFilter
  /** Why, for the rule's rationale; a keep asks for one when it's missing. */
  rationale?: string
}

export interface GateChoice {
  keep?: number
  line?: LineFilter
  rationale?: string
}

/** The identity of a confirmed toggle, so the same rule doesn't ask twice. */
export function logConfirmKey(rule: Pick<LogToggleCandidate, "kind" | "selector" | "label">) {
  return JSON.stringify(["log", rule.kind, selectorKey(rule.selector), rule.label ?? null])
}

/** Active rules a candidate's streams overlap: keeps that protect some of a drop's lines, or drops a keep narrows. */
function useOverlapping(candidate: LogToggleCandidate) {
  const rules = useAppStore((state) => state.logRules)
  return React.useMemo(() => {
    const overlap = (rule: LogRule) => rule.status === "active" && !selectorsDisjoint(rule.selector, candidate.selector)
    if (candidate.kind === "keep") return rules.filter((rule) => overlap(rule) && LINE_REMOVING_KINDS.includes(rule.kind))
    if (!LINE_REMOVING_KINDS.includes(candidate.kind)) return []
    return rules.filter((rule) => overlap(rule) && rule.kind === "keep")
  }, [rules, candidate.kind, candidate.selector])
}

export const KEEP_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.1", label: "10%" },
  { value: "0.01", label: "1%" },
] as const

const LINE_OPTIONS = [
  { value: "debug,trace", label: "debug + trace" },
  { value: "debug", label: "debug" },
  { value: "regex", label: "Regex" },
] as const

/** `{service_name="api"}`, or "all streams". */
export function selectorText(selector: StreamSelector) {
  if (!selector.matchers.length) return "all streams"
  try {
    return renderSelector(selector)
  } catch {
    return "(invalid selector)"
  }
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[13px] break-all">{children}</code>
}

function describeLine(line: LineFilter) {
  return line.levels?.length ? `${line.levels.join(", ")} lines` : <>lines matching <Code>/{line.regex}/</Code></>
}

export function LogRuleGate({
  candidate,
  hint,
  onConfirm,
  onCancel,
}: {
  candidate: LogToggleCandidate
  /** What the rule changes, when the caller knows (e.g. "−120 streams"). */
  hint?: React.ReactNode
  onConfirm: (choice: GateChoice) => void
  onCancel: () => void
}) {
  const { kind, selector, label } = candidate
  const target = React.useMemo(() => logRuleTarget({ kind, selector, label }), [kind, selector, label])
  const { summary, isPending } = useLogUsageSummary(target)
  const overlapping = useOverlapping(candidate)
  const [rationale, setRationale] = React.useState(candidate.rationale ?? "")
  const rationaleId = React.useId()
  const guard = kind === "drop_label" || kind === "label_to_metadata" ? guardedLogLabel(label) : undefined
  const [override, setOverride] = React.useState(false)
  const [keep, setKeep] = React.useState<(typeof KEEP_OPTIONS)[number]["value"]>("0.1")
  const [lineMode, setLineMode] = React.useState<(typeof LINE_OPTIONS)[number]["value"]>("debug,trace")
  const [regex, setRegex] = React.useState("")
  const overrideId = React.useId()
  const regexId = React.useId()

  const askLine = kind === "drop_lines" && !candidate.line
  const line: LineFilter | undefined = candidate.line ?? (askLine ? (lineMode === "regex" ? { regex } : { levels: lineMode.split(",") }) : undefined)
  const regexIssue = askLine && lineMode === "regex" ? (regex.trim() ? lineRegexProblem(regex) : "enter a regex") : null
  const rationaleIssue = kind === "keep" && !rationale.trim() ? "say why these lines must stay" : null
  const scope = selectorText(selector)
  const fullyProtected = overlapping.some((rule) => rule.kind === "keep" && keepCoversAll(rule, selector, candidate.line))

  const title =
    kind === "drop_streams" ? (
      <>Drop every line of <Code>{scope}</Code>?</>
    ) : kind === "drop_label" ? (
      <>Drop label <Code>{label}</Code> from <Code>{scope}</Code>?</>
    ) : kind === "label_to_metadata" ? (
      <>Move <Code>{label}</Code> to structured metadata in <Code>{scope}</Code>?</>
    ) : kind === "sample" ? (
      <>Sample {candidate.line ? describeLine(candidate.line) : "lines"} in <Code>{scope}</Code>?</>
    ) : kind === "keep" ? (
      <>Protect {candidate.line ? describeLine(candidate.line) : "every line"} in <Code>{scope}</Code>?</>
    ) : (
      <>Drop {candidate.line ? describeLine(candidate.line) : "lines"} in <Code>{scope}</Code>?</>
    )

  const explain =
    kind === "drop_streams" ? (
      <>The collector drops these <Term id="logStream">streams</Term> entirely; their volume and cost go away.</>
    ) : kind === "drop_label" ? (
      <>
        <Term id="logStream">Streams</Term> that differ only by {label} merge into one. Ingested bytes stay the same; the index and the number of{" "}
        <Term id="chunk">chunks</Term> shrink.
      </>
    ) : kind === "label_to_metadata" ? (
      <>
        {label} stays on every line as <Term id="structuredMetadata">structured metadata</Term>, filterable with{" "}
        <Code>| {label}="…"</Code>, but stops creating streams. Needs Loki 3.0 or later.
      </>
    ) : kind === "sample" ? (
      "The collector keeps a random share of matching lines and drops the rest."
    ) : kind === "keep" ? (
      <>
        A <Term id="keepRule">keep rule</Term>: your drop and sample rules leave these lines alone (exports narrow them), and{" "}
        <Term id="adaptiveLogs">Adaptive Logs</Term> gets an exemption for these streams on the next apply.
      </>
    ) : (
      "The collector drops matching lines; the rest of each stream stays."
    )

  const confirmText =
    kind === "label_to_metadata" ? "Move" : kind === "sample" ? "Sample" : kind === "drop_lines" ? "Drop lines" : kind === "keep" ? "Protect" : "Drop"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{explain}</p>
        {hint ? <p className="text-xs font-medium text-brand-ink tabular-nums">{hint}</p> : null}
      </div>

      {kind === "sample" ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Keep</span>
          <SegmentedControl aria-label="Share of lines to keep" size="sm" value={keep} onValueChange={setKeep} options={KEEP_OPTIONS} />
        </div>
      ) : null}

      {askLine ? (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Lines</span>
            <SegmentedControl aria-label="Lines to drop" size="sm" value={lineMode} onValueChange={setLineMode} options={LINE_OPTIONS} />
          </div>
          {lineMode === "regex" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={regexId} className="sr-only">
                Line regex
              </Label>
              <Input
                id={regexId}
                value={regex}
                autoFocus
                placeholder="e.g. GET /health"
                onChange={(event) => setRegex(event.target.value)}
                aria-invalid={Boolean(regex.trim() && regexIssue) || undefined}
                className="h-7 font-mono text-xs"
              />
              {regex.trim() && regexIssue ? <span className="text-destructive">{regexIssue}</span> : <span className="text-muted-foreground">RE2, matched anywhere in the line.</span>}
            </div>
          ) : (
            <span className="text-muted-foreground">Matched on the level in the line (level=debug, "level":"debug").</span>
          )}
        </div>
      ) : null}

      {kind === "keep" ? (
        <div className="flex flex-col gap-1 text-xs">
          <Label htmlFor={rationaleId} className="text-xs font-normal text-muted-foreground">
            Why these lines must stay
          </Label>
          <Input
            id={rationaleId}
            value={rationale}
            maxLength={MAX_RATIONALE}
            autoFocus
            placeholder="e.g. Needed for the audit trail"
            onChange={(event) => setRationale(event.target.value)}
            aria-invalid={Boolean(rationaleIssue) || undefined}
            className="h-7 text-xs"
          />
        </div>
      ) : null}

      {overlapping.length ? (
        <div className="flex flex-col gap-1 rounded-lg border border-brand/25 bg-brand/5 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-brand-ink">
            <ShieldCheckIcon className="size-4" aria-hidden />
            {kind === "keep"
              ? `Narrows ${overlapping.length} active rule${overlapping.length === 1 ? "" : "s"}`
              : fullyProtected
                ? "A keep rule protects every line this would remove"
                : `Leaves the lines of ${overlapping.length} keep rule${overlapping.length === 1 ? "" : "s"} alone`}
          </p>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {overlapping.slice(0, 3).map((rule) => (
              <li key={rule.id} className="break-all">
                {describeLogRule(rule)}
              </li>
            ))}
            {overlapping.length > 3 ? <li>and {overlapping.length - 3} more</li> : null}
          </ul>
        </div>
      ) : null}

      {guard ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <ShieldWarningIcon className="size-4" aria-hidden />
            {guard.title}
          </p>
          <p>{guard.reason}</p>
        </div>
      ) : null}

      {target ? (
        <div className="-mx-1 flex max-h-[max(10rem,calc(var(--radix-popover-content-available-height,100vh)-12rem))] min-h-0 flex-col gap-3 overflow-y-auto px-1">
          <EvidenceList summary={summary} pending={isPending} />
        </div>
      ) : null}

      {guard ? (
        <div className="flex items-center gap-2">
          <Checkbox id={overrideId} checked={override} onCheckedChange={(value) => setOverride(value === true)} />
          <Label htmlFor={overrideId} className="text-xs font-normal">
            I understand; {kind === "drop_label" ? "drop" : "move"} <code className="font-mono">{label}</code> anyway
          </Label>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={kind === "keep" ? "default" : "destructive"}
          disabled={(Boolean(guard) && !override) || Boolean(regexIssue) || Boolean(rationaleIssue)}
          autoFocus={!guard && !(askLine && lineMode === "regex") && kind !== "keep"}
          onClick={() =>
            onConfirm({
              ...(kind === "sample" ? { keep: Number(keep) } : {}),
              ...(line ? { line: askLine && lineMode === "regex" ? { regex: regex.trim() } : line } : {}),
              ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
            })
          }
        >
          {summary?.used ? `${confirmText} anyway` : confirmText}
        </Button>
      </div>
    </div>
  )
}
