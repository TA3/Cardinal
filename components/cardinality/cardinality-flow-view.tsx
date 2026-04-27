"use client"

import * as React from "react"
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getScaleTextStyle } from "@/lib/cardinality/color-scale"
import type {
  CardinalityFlowEdge,
  CardinalityFlowNode,
  CardinalityFlowNodeData,
} from "@/lib/cardinality/flow-model"
import { buildCardinalityFlowGraph } from "@/lib/cardinality/flow-transformers"
import type { MetricDrilldown, SnapshotResponse } from "@/lib/prometheus/types"
import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"

interface CardinalityFlowViewProps {
  snapshot: SnapshotResponse
  topMetricsPerJob: number
  onTopMetricsPerJobChange: (value: number) => void
  expandedMetricPreviews: string[]
  metricPreviewCache: Record<string, MetricDrilldown>
  metricPreviewLoading: Record<string, boolean>
  metricPreviewErrors: Record<string, string>
  dropMetrics: string[]
  selectedLabelsByMetric: Record<string, string[]>
  onOpenJob: (job: string) => void
  onOpenMetric: (metric: string) => void
  onToggleMetricDrop: (metric: string) => void
  onToggleLabelDrop: (metric: string, label: string) => void
  onToggleMetricLabels: (metric: string) => void
}

function FlowNodeLabel({
  data,
  metricPreviewLoading,
  metricPreviewErrors,
  onOpenJob,
  onOpenMetric,
  onToggleMetricDrop,
  onToggleLabelDrop,
  onToggleMetricLabels,
}: {
  data: CardinalityFlowNodeData
  metricPreviewLoading: Record<string, boolean>
  metricPreviewErrors: Record<string, string>
  onOpenJob: (job: string) => void
  onOpenMetric: (metric: string) => void
  onToggleMetricDrop: (metric: string) => void
  onToggleLabelDrop: (metric: string, label: string) => void
  onToggleMetricLabels: (metric: string) => void
}) {
  const isMetric = data.kind === "metric"
  const isLabel = data.kind === "label"
  const isJob = data.kind === "job"

  return (
    <div
      className={cn(
        "w-[200px] rounded-xl border bg-card px-3 py-2 text-left shadow-sm",
        isMetric && data.isDropped && "border-primary/50 bg-primary/5",
        isLabel && data.isLabelDropped && "border-primary/50 bg-primary/5"
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="break-all text-xs font-semibold leading-tight">{data.title}</p>
        {typeof data.percentage === "number" ? (
          <span
            className="shrink-0 text-[10px] font-medium leading-tight"
            style={getScaleTextStyle(data.percentage, "risk")}
          >
            {data.percentage.toFixed(1)}%
          </span>
        ) : null}
      </div>

      {data.subtitle ? (
        <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{data.subtitle}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1">
        {isJob && data.jobName ? (
          <Button
            size="xs"
            variant="outline"
            className="nodrag h-6 px-2 text-[10px]"
            onClick={(event) => {
              event.stopPropagation()
              onOpenJob(data.jobName!)
            }}
          >
            Open job
          </Button>
        ) : null}

        {isMetric && data.metricName ? (
          <>
            <Button
              size="xs"
              variant="outline"
              className="nodrag h-6 px-2 text-[10px]"
              onClick={(event) => {
                event.stopPropagation()
                onOpenMetric(data.metricName!)
              }}
            >
              Open
            </Button>
            <Button
              size="xs"
              variant={data.isDropped ? "secondary" : "outline"}
              className="nodrag h-6 px-2 text-[10px]"
              onClick={(event) => {
                event.stopPropagation()
                onToggleMetricDrop(data.metricName!)
              }}
            >
              {data.isDropped ? "Undrop" : "Drop"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="nodrag h-6 px-2 text-[10px]"
              onClick={(event) => {
                event.stopPropagation()
                onToggleMetricLabels(data.metricName!)
              }}
            >
              {data.labelsExpanded ? "Hide" : "Labels"}
            </Button>
            {metricPreviewLoading[data.metricName] ? (
              <Badge variant="secondary" className="text-[10px]">Loading...</Badge>
            ) : null}
            {metricPreviewErrors[data.metricName] ? (
              <Badge variant="destructive" className="text-[10px]">Failed</Badge>
            ) : null}
          </>
        ) : null}

        {isLabel && data.metricName && data.labelName ? (
          <Button
            size="xs"
            variant={data.isLabelDropped ? "secondary" : "outline"}
            className="nodrag h-6 px-2 text-[10px]"
            onClick={(event) => {
              event.stopPropagation()
              onToggleLabelDrop(data.metricName!, data.labelName!)
            }}
          >
            {data.isLabelDropped ? "Undrop" : "Drop"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

interface FlowCardinalityNodeProps extends NodeProps<CardinalityFlowNode> {
  metricPreviewLoading: Record<string, boolean>
  metricPreviewErrors: Record<string, string>
  onOpenJob: (job: string) => void
  onOpenMetric: (metric: string) => void
  onToggleMetricDrop: (metric: string) => void
  onToggleLabelDrop: (metric: string, label: string) => void
  onToggleMetricLabels: (metric: string) => void
}

function FlowCardinalityNode({
  data,
  metricPreviewLoading,
  metricPreviewErrors,
  onOpenJob,
  onOpenMetric,
  onToggleMetricDrop,
  onToggleLabelDrop,
  onToggleMetricLabels,
}: FlowCardinalityNodeProps) {
  return (
    <>
      {data.kind !== "job" ? (
        <Handle
          type="target"
          position={Position.Left}
          style={{ opacity: 0, pointerEvents: "none" }}
        />
      ) : null}
      <FlowNodeLabel
        data={data}
        metricPreviewLoading={metricPreviewLoading}
        metricPreviewErrors={metricPreviewErrors}
        onOpenJob={onOpenJob}
        onOpenMetric={onOpenMetric}
        onToggleMetricDrop={onToggleMetricDrop}
        onToggleLabelDrop={onToggleLabelDrop}
        onToggleMetricLabels={onToggleMetricLabels}
      />
      {data.kind !== "label" ? (
        <Handle
          type="source"
          position={Position.Right}
          style={{ opacity: 0, pointerEvents: "none" }}
        />
      ) : null}
    </>
  )
}

export function CardinalityFlowView({
  snapshot,
  topMetricsPerJob,
  onTopMetricsPerJobChange,
  expandedMetricPreviews,
  metricPreviewCache,
  metricPreviewLoading,
  metricPreviewErrors,
  dropMetrics,
  selectedLabelsByMetric,
  onOpenJob,
  onOpenMetric,
  onToggleMetricDrop,
  onToggleLabelDrop,
  onToggleMetricLabels,
}: CardinalityFlowViewProps) {
  const graph = React.useMemo(
    () =>
      buildCardinalityFlowGraph({
        snapshot,
        topMetricsPerJob,
        expandedMetricIds: expandedMetricPreviews,
        metricPreviewCache,
        dropMetrics,
        selectedLabelsByMetric,
      }),
    [
      dropMetrics,
      expandedMetricPreviews,
      metricPreviewCache,
      selectedLabelsByMetric,
      snapshot,
      topMetricsPerJob,
    ]
  )

  const nodeTypes = React.useMemo(
    () => ({
      cardinality: (props: NodeProps<CardinalityFlowNode>) => (
        <FlowCardinalityNode
          {...props}
          metricPreviewLoading={metricPreviewLoading}
          metricPreviewErrors={metricPreviewErrors}
          onOpenJob={onOpenJob}
          onOpenMetric={onOpenMetric}
          onToggleMetricDrop={onToggleMetricDrop}
          onToggleLabelDrop={onToggleLabelDrop}
          onToggleMetricLabels={onToggleMetricLabels}
        />
      ),
    }),
    [
      metricPreviewErrors,
      metricPreviewLoading,
      onOpenJob,
      onOpenMetric,
      onToggleLabelDrop,
      onToggleMetricDrop,
      onToggleMetricLabels,
    ]
  )

//   useTheme
const { theme } = useTheme()

  return (
    <div className="rounded-2xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-sm font-medium">Flow view</p>
          <p className="text-xs text-muted-foreground">
            Jobs to top metrics per job to lazy-loaded labels
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="flow-top-metrics">
            Top X / job
          </label>
          <Input
            id="flow-top-metrics"
            type="number"
            min={1}
            max={50}
            value={topMetricsPerJob}
            onChange={(event) => {
              const next = Math.max(1, Math.min(50, Number(event.target.value) || 10))
              onTopMetricsPerJobChange(next)
            }}
            className="h-8 w-20"
          />
        </div>
      </div>

      <div className="h-[70svh] w-full overflow-hidden">
        <ReactFlow<CardinalityFlowNode, CardinalityFlowEdge>
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          colorMode={theme === "dark" ? "dark" : "light"}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  )
}
