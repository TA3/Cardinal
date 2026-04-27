import type { Edge, Node } from "@xyflow/react"

export type CardinalityNodeKind = "job" | "metric" | "label"

export interface CardinalityFlowNodeData extends Record<string, unknown> {
  kind: CardinalityNodeKind
  id: string
  title: string
  subtitle?: string
  metricName?: string
  jobName?: string
  labelName?: string
  percentage?: number
  isDropped?: boolean
  isLabelDropped?: boolean
  canExpandLabels?: boolean
  labelsExpanded?: boolean
}

export type CardinalityFlowNode = Node<CardinalityFlowNodeData>
export type CardinalityFlowEdge = Edge
