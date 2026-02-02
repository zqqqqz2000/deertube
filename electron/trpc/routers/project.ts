import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { z } from 'zod'
import { baseProcedure, createTRPCRouter } from '../init'

interface ProjectState {
  version: number
  nodes: unknown[]
  edges: unknown[]
  updatedAt: string
}

interface RecentProject {
  path: string
  name: string
  lastOpened: string
}

function getRecentsPath() {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  }
  catch {
    return fallback
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function readRecents(): Promise<RecentProject[]> {
  return readJsonFile<RecentProject[]>(getRecentsPath(), [])
}

async function writeRecents(recents: RecentProject[]) {
  await writeJsonFile(getRecentsPath(), recents)
}

async function updateRecents(projectPath: string) {
  const recents = await readRecents()
  const name = path.basename(projectPath)
  const now = new Date().toISOString()
  const filtered = recents.filter((item) => item.path !== projectPath)
  const next = [{ path: projectPath, name, lastOpened: now }, ...filtered].slice(0, 12)
  await writeRecents(next)
  return next
}

async function deleteRecent(projectPath: string) {
  const recents = await readRecents()
  const next = recents.filter((item) => item.path !== projectPath)
  await writeRecents(next)
  return next
}

function getProjectStore(projectPath: string) {
  const baseDir = path.join(projectPath, '.deertube')
  return {
    baseDir,
    statePath: path.join(baseDir, 'state.json'),
    pagesDir: path.join(baseDir, 'pages'),
    searchesDir: path.join(baseDir, 'searches'),
  }
}

async function ensureProjectStore(projectPath: string) {
  const store = getProjectStore(projectPath)
  await fs.mkdir(store.pagesDir, { recursive: true })
  await fs.mkdir(store.searchesDir, { recursive: true })
  return store
}

async function loadProjectState(projectPath: string): Promise<ProjectState> {
  const store = await ensureProjectStore(projectPath)
  const fallback: ProjectState = {
    version: 1,
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  }
  const state = await readJsonFile(store.statePath, fallback)
  return {
    ...fallback,
    ...state,
  }
}

async function saveProjectState(projectPath: string, state: ProjectState) {
  const store = await ensureProjectStore(projectPath)
  const payload: ProjectState = {
    ...state,
    version: state.version ?? 1,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(store.statePath, payload)
}

export const projectRouter = createTRPCRouter({
  listRecent: baseProcedure.query(async () => readRecents()),
  choose: baseProcedure.mutation(async () => {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  }),
  open: baseProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => {
      await updateRecents(input.path)
      const state = await loadProjectState(input.path)
      return {
        path: input.path,
        name: path.basename(input.path),
        state,
      }
    }),
  saveState: baseProcedure
    .input(
      z.object({
        path: z.string(),
        state: z.object({
          version: z.number().optional(),
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      await saveProjectState(input.path, {
        version: input.state.version ?? 1,
        nodes: input.state.nodes,
        edges: input.state.edges,
        updatedAt: new Date().toISOString(),
      })
      return { ok: true }
    }),
  deleteRecent: baseProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => {
      const recents = await deleteRecent(input.path)
      return { ok: true, recents }
    }),
})

export type ProjectRouter = typeof projectRouter

export type ProjectStore = ReturnType<typeof getProjectStore>
export { ensureProjectStore, getProjectStore }
