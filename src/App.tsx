import { useCallback, useEffect, useState } from 'react'
import type { FlowEdge, FlowNode } from './types/flow'
import type { ChatMessage } from './types/chat'
import ProjectPicker, { type ProjectOpenResult } from './components/ProjectPicker'
import FlowWorkspace from './components/FlowWorkspace'
import { applyTheme, getInitialTheme, THEME_STORAGE_KEY, type Theme } from './lib/theme'
import { trpc } from './lib/trpc'

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
  const [initializing, setInitializing] = useState(true)
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme())

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const handleOpen = useCallback((result: ProjectOpenResult) => {
    setProject({ path: result.path, name: result.name })
    setProjectState({
      nodes: result.state.nodes,
      edges: result.state.edges,
      chat: result.state.chat ?? [],
      autoLayoutLocked:
        typeof result.state.autoLayoutLocked === 'boolean'
          ? result.state.autoLayoutLocked
          : true,
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    trpc.project.openDefault
      .mutate()
      .then((result) => {
        if (cancelled) {
          return
        }
        handleOpen(result)
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) {
          return
        }
        setInitializing(false)
      })
    return () => {
      cancelled = true
    }
  }, [handleOpen])

  if (initializing && !project) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <div className="rounded-xl border border-border/70 bg-card/80 px-6 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
          Loading workspace...
        </div>
      </div>
    )
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
