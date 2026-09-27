import { TerminalWindowIcon } from "@phosphor-icons/react"

import { EmptyState } from "@/components/empty-state"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useAppStore } from "@/lib/store/app-store"

export function ActivitySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activityLog = useAppStore((state) => state.activityLog)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
          <SheetDescription>Queries and actions in this tab, newest first.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {activityLog.length === 0 ? (
            <EmptyState icon={TerminalWindowIcon} title="No activity yet" description="Snapshots, imports and agent actions show up here." />
          ) : (
            <ol className="flex flex-col gap-1.5 font-mono text-xs">
              {activityLog.map((entry, index) => (
                <li key={`${index}-${entry}`} className="break-words text-muted-foreground first:text-foreground">
                  {entry}
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
