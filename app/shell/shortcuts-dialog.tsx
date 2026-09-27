import { Fragment } from "react"

import { shortcutGroups } from "@/app/shell/hotkeys"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useAppStore } from "@/lib/store/app-store"

/** The `?` overlay: every keyboard shortcut, grouped. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const signal = useAppStore((state) => state.signal)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-key shortcuts pause while you type or a dialog is open.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex max-h-[65svh] flex-col gap-5 overflow-y-auto px-1">
          {shortcutGroups(signal).map((group) => (
            <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
              <h3 id={`shortcuts-${group.title}`} className="mb-1.5 text-xs font-medium text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col">
                {group.items.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
                    <dt>{item.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {item.keys.map((combo, index) => (
                        <Fragment key={combo.join("+")}>
                          {index > 0 ? <span>or</span> : null}
                          <KbdGroup>
                            {combo.map((key, keyIndex) => (
                              <Fragment key={`${keyIndex}-${key}`}>
                                {keyIndex > 0 && combo[0] === "G" ? <span className="text-muted-foreground/60">then</span> : null}
                                <Kbd>{key}</Kbd>
                              </Fragment>
                            ))}
                          </KbdGroup>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
