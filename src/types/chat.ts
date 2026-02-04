export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  status?: 'pending' | 'complete' | 'failed'
  error?: string
  requestText?: string
}

export interface GraphEvent {
  id: string
  status: 'running' | 'complete' | 'failed'
  createdAt: string
  endedAt?: string
  responseId: string
  nodesAdded?: number
  error?: string
}
