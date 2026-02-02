import type { Edge, Node } from 'reactflow'

export interface QuestionNodeData {
  question: string
  answer: string
  status?: 'running' | 'failed'
}

export interface SourceNodeData {
  title: string
  url: string
  snippet?: string
}

export type FlowNodeData = QuestionNodeData | SourceNodeData
export type QuestionNode = Node<QuestionNodeData, 'question'>
export type SourceNode = Node<SourceNodeData, 'source'>
export type FlowNode = Node<FlowNodeData>
export type FlowEdge = Edge
