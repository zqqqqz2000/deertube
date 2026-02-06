import { useEffect, useState } from 'react'
import type { FlowEdge, FlowNode } from './types/flow'
import type { ChatMessage } from './types/chat'
import ProjectPicker, { type ProjectOpenResult } from './components/ProjectPicker'
import FlowWorkspace from './components/FlowWorkspace'
import { applyTheme, getInitialTheme, THEME_STORAGE_KEY, type Theme } from './lib/theme'

interface ProjectInfo {
  path: string
  name: string
}

interface ProjectState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  chat: ChatMessage[]
  autoLayoutLocked?: boolean
}

function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [projectState, setProjectState] = useState<ProjectState | null>(null)
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme())

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const handleOpen = (result: ProjectOpenResult) => {
    setProject({ path: result.path, name: result.name })
    setProjectState({
      nodes: result.state.nodes as FlowNode[],
      edges: result.state.edges as FlowEdge[],
      chat: (result.state.chat ?? []) as ChatMessage[],
      autoLayoutLocked:
        typeof result.state.autoLayoutLocked === 'boolean'
          ? result.state.autoLayoutLocked
          : true,
    })
  }

  return (
    <div className="h-screen w-screen">
      {project && projectState ? (
        <FlowWorkspace
          project={project}
          initialState={projectState}
          theme={theme}
          onToggleTheme={() =>
            setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
          }
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
