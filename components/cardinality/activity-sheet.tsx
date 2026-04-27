"use client"

import { Clock3 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

interface ActivitySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activityLog: string[]
}

export function ActivitySheet({
  open,
  onOpenChange,
  activityLog,
}: ActivitySheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Clock3 className="size-4" />
            Live activity log
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="rounded-xl bg-muted/30 p-3 font-mono text-xs">
            {activityLog.length === 0 ? (
              <p className="text-muted-foreground">No activity yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {activityLog.map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
