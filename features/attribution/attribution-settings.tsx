import * as React from "react"
import { ArrowRightIcon, TagIcon } from "@phosphor-icons/react"
import { Link, useLocation } from "react-router"

import { paths } from "@/app/paths"
import { InfoTip } from "@/components/info-tip"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { LabelPicker } from "@/features/attribution/label-picker"
import { useLabelNames } from "@/features/attribution/use-attribution"
import { ATTRIBUTION_LEVELS, SUGGESTED_ATTRIBUTION_LABELS, attributionChain } from "@/lib/core/attribution"
import { useAppStore } from "@/lib/store/app-store"
import { cn } from "@/lib/utils"

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">{children}</code>
}

/** Settings → Attribution: the switch, the three attribution labels and how they resolve. */
export function AttributionSection() {
  const { enabled, labels, owners } = useAppStore((state) => state.attribution)
  const setAttribution = useAppStore((state) => state.setAttribution)
  const hasConnection = useAppStore((state) => Boolean(state.settings.baseUrl.trim()))
  const { names, isPending } = useLabelNames(hasConnection)
  const chain = attributionChain(labels)
  const { hash } = useLocation()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (hash === "#attribution") ref.current?.scrollIntoView({ block: "start" })
  }, [hash])
  const [first, second, third] = ATTRIBUTION_LEVELS.map((_, index) => labels[index] || null)

  const toggle = (next: boolean) => {
    // First time on: start from the common ownership labels this backend has.
    if (next && labels.every((label) => !label) && names) {
      const found = SUGGESTED_ATTRIBUTION_LABELS.filter((label) => names.includes(label)).slice(0, 3)
      setAttribution({ enabled: true, labels: [...found, "", "", ""].slice(0, 3) })
      return
    }
    setAttribution({ enabled: next })
  }

  const setLabel = (index: number, value: string) => {
    const next = [...labels]
    next[index] = value
    setAttribution({ labels: next })
  }

  const usedBy = (index: number) =>
    Object.fromEntries(labels.flatMap((label, at) => (label && at !== index ? [[label, ATTRIBUTION_LEVELS[at]]] : [])))

  return (
    <Card id="attribution" ref={ref} className="scroll-mt-28">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TagIcon className="size-4 text-muted-foreground" />
          Attribution
        </CardTitle>
        <CardDescription>Owner cost and savings, by labels such as team or namespace.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field orientation="horizontal">
          <FieldLabel htmlFor="attribution-enabled" className="gap-1">
            Enable attribution
            <InfoTip label="What does it add?">Adds the Attribution tab, owner badges on jobs and the agent's get_attribution tool.</InfoTip>
          </FieldLabel>
          <Switch id="attribution-enabled" checked={enabled} onCheckedChange={toggle} />
        </Field>

        <div className={cn("flex flex-col gap-5 transition-opacity motion-reduce:transition-none", !enabled && "pointer-events-none opacity-50")} aria-disabled={!enabled || undefined}>
          <div className="grid gap-3 sm:grid-cols-3">
            {ATTRIBUTION_LEVELS.map((level, index) => (
              <Field key={level}>
                <FieldLabel htmlFor={`attribution-label-${index}`}>{level} label</FieldLabel>
                <LabelPicker
                  id={`attribution-label-${index}`}
                  aria-label={`${level} attribution label`}
                  value={labels[index] ?? ""}
                  onChange={(value) => setLabel(index, value)}
                  names={names}
                  loadingNames={isPending}
                  usedBy={usedBy(index)}
                />
              </Field>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {chain.length ? `Attributed by ${chain.join(" → ")}${owners.length ? ", then custom rules" : ""}` : owners.length ? "Custom rules only" : "Pick a label or add custom rules"}
              <InfoTip label="How attribution resolves">
                <ol className="flex list-decimal flex-col gap-1 pl-4">
                  <li>Each series goes to its {first ? <Code>{first}</Code> : "Primary label"}'s value.</li>
                  <li>
                    Without it, the {second ? <Code>{second}</Code> : "Secondary label"}, then the {third ? <Code>{third}</Code> : "Third"}.
                  </li>
                  <li>
                    Then the custom rules ({owners.length} owner{owners.length === 1 ? "" : "s"} matching job, metric prefix or label).
                  </li>
                  <li>Whatever is left is Unattributed.</li>
                </ol>
              </InfoTip>
            </span>
            <Button asChild variant="outline" size="sm">
              <Link to={paths.attribution}>
                {owners.length ? "Edit custom rules" : "Open Attribution"}
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

