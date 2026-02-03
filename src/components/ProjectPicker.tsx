import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export interface ProjectOpenResult {
  path: string
  name: string
  state: {
    nodes: unknown[]
    edges: unknown[]
    chat?: unknown[]
  }
}

interface RecentProject {
  path: string
  name: string
  lastOpened: string
}

interface ProjectPickerProps {
  onOpen: (project: ProjectOpenResult) => void
}

export default function ProjectPicker({ onOpen }: ProjectPickerProps) {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)
  const [projectName, setProjectName] = useState('')

  useEffect(() => {
    trpc.project.listRecent.query().then(setRecents).catch(() => setRecents([]))
  }, [])

  const handleOpenPath = async (projectPath: string) => {
    setLoading(true)
    try {
      const result = await trpc.project.open.mutate({ path: projectPath })
      onOpen(result)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (projectPath: string) => {
    setLoading(true)
    try {
      const result = await trpc.project.deleteRecent.mutate({ path: projectPath })
      setRecents(result.recents)
    } finally {
      setLoading(false)
    }
  }

  const handleBrowse = async () => {
    setLoading(true)
    try {
      const projectPath = await trpc.project.choose.mutate()
      if (!projectPath) {
        return
      }
      const result = await trpc.project.open.mutate({ path: projectPath })
      onOpen(result)
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    const name = projectName.trim()
    if (!name) {
      return
    }
    setLoading(true)
    try {
      const result = await trpc.project.create.mutate({ name })
      onOpen(result)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-8 py-16">
        <Card className="border-white/10 bg-white/5 text-white shadow-2xl shadow-black/40 backdrop-blur">
          <CardContent className="flex flex-wrap items-center justify-between gap-10 p-10">
            <div className="max-w-2xl">
              <p className="text-xs uppercase tracking-[0.3em] text-white/60">DeepSearch Workspace</p>
              <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
                Choose a project directory
              </h1>
              <p className="mt-4 text-sm text-white/70 md:text-base">
                Your knowledge graph and source archives live inside the selected folder.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Project name"
                className="h-10 w-48 border-white/10 bg-white/5 text-sm text-white placeholder:text-white/40"
              />
              <Button
                className="bg-gradient-to-r from-emerald-400 via-teal-400 to-sky-400 text-sm font-semibold text-slate-900 shadow-lg shadow-emerald-500/30 hover:-translate-y-0.5 hover:shadow-xl"
                onClick={handleCreate}
                disabled={loading || !projectName.trim()}
              >
                {loading ? 'Creating...' : 'Create project'}
              </Button>
              <Button
                className="bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 text-sm font-semibold text-slate-900 shadow-lg shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-xl"
                onClick={handleBrowse}
                disabled={loading}
              >
                {loading ? 'Opening...' : 'Browse for folder'}
              </Button>
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <div className="text-xs uppercase tracking-[0.3em] text-white/50">Recent projects</div>
          {recents.length === 0 ? (
            <Card className="border-dashed border-white/10 bg-white/5 text-white/60">
              <CardContent className="p-6 text-sm">No recent projects yet.</CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {recents.map((project) => (
                <Card
                  key={project.path}
                  className="border-white/10 bg-slate-900/70 text-left text-white shadow-lg shadow-black/40"
                >
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start p-0 text-left hover:bg-transparent"
                      onClick={() => handleOpenPath(project.path)}
                      disabled={loading}
                    >
                      <div>
                        <div className="text-lg font-semibold">{project.name}</div>
                        <div className="text-xs text-white/60">{project.path}</div>
                        <div className="text-xs text-white/40">
                          {new Date(project.lastOpened).toLocaleString()}
                        </div>
                      </div>
                    </Button>
                    <div className="mt-auto flex items-center justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-red-400/40 text-[0.65rem] uppercase tracking-[0.2em] text-red-200 hover:bg-red-500/10 hover:text-red-200"
                        onClick={() => handleDelete(project.path)}
                        disabled={loading}
                      >
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
