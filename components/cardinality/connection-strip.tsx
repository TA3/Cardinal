"use client"

import { ChevronDown, Database, RefreshCw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface ConnectionStripProps {
  baseUrl: string
  authMode: string
  isLoadingSnapshot: boolean
  onExpand: () => void
  onRefresh: () => void
  onDisconnect: () => void
}

export function ConnectionStrip({
  baseUrl,
  authMode,
  isLoadingSnapshot,
  onExpand,
  onRefresh,
  onDisconnect,
}: ConnectionStripProps) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <Database className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{baseUrl}</span>
        <Badge
          variant={authMode === "Anonymous" ? "secondary" : "outline"}
          className="shrink-0 text-xs"
        >
          {authMode}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onExpand}>
          <ChevronDown className="size-3.5" />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isLoadingSnapshot}
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          <Trash2 className="size-3.5" />
          Disconnect
        </Button>
      </div>
    </div>
  )
}
