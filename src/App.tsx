import { useState } from 'react'
import type { FlowEdge, FlowNode } from './types/flow'
import type { ChatMessage } from './types/chat'
import ProjectPicker, { type ProjectOpenResult } from './components/ProjectPicker'
import FlowWorkspace from './components/FlowWorkspace'

interface ProjectInfo {
  path: string
  name: string
}

interface ProjectState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  chat: ChatMessage[]
}

function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [projectState, setProjectState] = useState<ProjectState | null>(null)

  const handleOpen = (result: ProjectOpenResult) => {
    setProject({ path: result.path, name: result.name })
    setProjectState({
      nodes: result.state.nodes as FlowNode[],
      edges: result.state.edges as FlowEdge[],
      chat: (result.state.chat ?? []) as ChatMessage[],
    })
  }

  return (
    <div className="h-screen w-screen">
      {project && projectState ? (
        <FlowWorkspace
          project={project}
          initialState={projectState}
          onExit={() => {
            setProject(null)
            setProjectState(null)
          }}
        />
      ) : (
        <ProjectPicker onOpen={handleOpen} />
      )}
    </div>
  )
}

export default App
