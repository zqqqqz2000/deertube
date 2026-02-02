import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'

export type ProjectOpenResult = {
  path: string
  name: string
  state: {
    nodes: unknown[]
    edges: unknown[]
  }
}

type RecentProject = {
  path: string
  name: string
  lastOpened: string
}

type ProjectPickerProps = {
  onOpen: (project: ProjectOpenResult) => void
}

export default function ProjectPicker({ onOpen }: ProjectPickerProps) {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-8 py-16">
        <div className="flex flex-wrap items-center justify-between gap-10 rounded-3xl border border-white/10 bg-white/5 p-10 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="max-w-2xl">
            <p className="text-xs uppercase tracking-[0.3em] text-white/60">DeepSearch Workspace</p>
            <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
              Choose a project directory
            </h1>
            <p className="mt-4 text-sm text-white/70 md:text-base">
              Your knowledge graph and source archives live inside the selected folder.
            </p>
          </div>
          <button
            className="rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 px-6 py-3 text-sm font-semibold text-slate-900 shadow-lg shadow-orange-500/30 transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleBrowse}
            disabled={loading}
          >
            {loading ? 'Opening...' : 'Browse for folder'}
          </button>
        </div>
        <div className="flex flex-col gap-4">
          <div className="text-xs uppercase tracking-[0.3em] text-white/50">Recent projects</div>
          {recents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-sm text-white/60">
              No recent projects yet.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {recents.map((project) => (
                <div
                  key={project.path}
                  className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-5 text-left text-white shadow-lg shadow-black/40"
                >
                  <button
                    className="text-left transition hover:-translate-y-0.5 hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => handleOpenPath(project.path)}
                    disabled={loading}
                  >
                    <div className="text-lg font-semibold">{project.name}</div>
                    <div className="text-xs text-white/60">{project.path}</div>
                    <div className="text-xs text-white/40">
                      {new Date(project.lastOpened).toLocaleString()}
                    </div>
                  </button>
                  <div className="flex items-center justify-end">
                    <button
                      className="rounded-full border border-red-400/40 px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-red-200 transition hover:border-red-300/70 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => handleDelete(project.path)}
                      disabled={loading}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
