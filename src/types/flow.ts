import type { Edge, Node } from 'reactflow'

export type QuestionNodeData = {
  question: string
  answer: string
  status?: string
}

export type SourceNodeData = {
  title: string
  url: string
  snippet?: string
}

export type QuestionNode = Node<QuestionNodeData, 'question'>
export type SourceNode = Node<SourceNodeData, 'source'>
export type FlowNode = QuestionNode | SourceNode
export type FlowEdge = Edge
