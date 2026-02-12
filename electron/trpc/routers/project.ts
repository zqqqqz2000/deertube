import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { z } from 'zod'
import { baseProcedure, createTRPCRouter } from '../init'
import type { FlowEdge, FlowNode } from '../../../src/types/flow'
import type { ChatMessage } from '../../../src/types/chat'

interface ChatSessionState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  chat: ChatMessage[]
  autoLayoutLocked?: boolean
}

interface ProjectChatRecord {
  id: string
  title: string
  firstQuestion: string
  createdAt: string
  updatedAt: string
  state: ChatSessionState
}

interface ProjectChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface ProjectStoreState {
  version: number
  chats: ProjectChatRecord[]
  activeChatId: string | null
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

function getDefaultProjectsRoot() {
  return path.join(app.getPath('documents'), 'Deertube Projects')
}

function getDefaultProjectPath() {
  return path.join(getDefaultProjectsRoot(), 'default')
}

function sanitizeProjectName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '').trim()
}

async function ensureUniqueProjectPath(root: string, name: string) {
  const base = sanitizeProjectName(name)
  if (!base) {
    throw new Error('Project name is required')
  }
  const exists = async (candidate: string) => {
    try {
      await fs.stat(candidate)
      return true
    } catch {
      return false
    }
  }
  const candidate = path.join(root, base)
  if (!(await exists(candidate))) {
    return candidate
  }
  let suffix = 2
  while (await exists(`${candidate} ${suffix}`)) {
    suffix += 1
  }
  return `${candidate} ${suffix}`
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

async function writeJsonFile<T>(filePath: string, data: T) {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toTimestamp(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortChatRecords(chats: ProjectChatRecord[]) {
  return [...chats].sort(
    (left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  )
}

function toChatSummary(chat: ProjectChatRecord): ProjectChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  }
}

function toChatSummaries(chats: ProjectChatRecord[]): ProjectChatSummary[] {
  return sortChatRecords(chats).map((chat) => toChatSummary(chat))
}

function normalizeChatState(
  state: Partial<ChatSessionState> | undefined,
): ChatSessionState {
  return {
    nodes: Array.isArray(state?.nodes) ? state.nodes : [],
    edges: Array.isArray(state?.edges) ? state.edges : [],
    chat: Array.isArray(state?.chat) ? state.chat : [],
    autoLayoutLocked:
      typeof state?.autoLayoutLocked === 'boolean' ? state.autoLayoutLocked : true,
  }
}

function createEmptyChatState(): ChatSessionState {
  return {
    nodes: [],
    edges: [],
    chat: [],
    autoLayoutLocked: true,
  }
}

function normalizeFirstQuestion(question: string): string {
  const withoutNodePrefix = question.replace(/^\s*(?:\[\[node:[^\]]+\]\]\s*)+/i, '')
  return withoutNodePrefix.replace(/\s+/g, ' ').trim()
}

function buildChatTitle(firstQuestion: string): string {
  const normalized = normalizeFirstQuestion(firstQuestion)
  if (!normalized) {
    return 'New chat'
  }
  const maxLength = 64
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 3)}...`
}

function findFirstUserQuestion(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const normalized = normalizeFirstQuestion(message.content)
    if (normalized) {
      return normalized
    }
  }
  return ''
}

function createEmptyProjectStoreState(): ProjectStoreState {
  return {
    version: 2,
    chats: [],
    activeChatId: null,
    updatedAt: new Date().toISOString(),
  }
}

function normalizeChatRecord(
  value: unknown,
  fallbackCreatedAt: string,
): ProjectChatRecord | null {
  if (!isObject(value)) {
    return null
  }
  const rawState = isObject(value.state) ? value.state : value
  const state = normalizeChatState({
    nodes: rawState.nodes as FlowNode[] | undefined,
    edges: rawState.edges as FlowEdge[] | undefined,
    chat: rawState.chat as ChatMessage[] | undefined,
    autoLayoutLocked: rawState.autoLayoutLocked as boolean | undefined,
  })
  const fallbackFirstQuestion = findFirstUserQuestion(state.chat)
  const firstQuestion =
    typeof value.firstQuestion === 'string'
      ? normalizeFirstQuestion(value.firstQuestion)
      : fallbackFirstQuestion
  const title =
    typeof value.title === 'string' && value.title.trim().length > 0
      ? value.title.trim()
      : buildChatTitle(firstQuestion)
  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt
      ? value.createdAt
      : fallbackCreatedAt
  const updatedAt =
    typeof value.updatedAt === 'string' && value.updatedAt
      ? value.updatedAt
      : createdAt
  const id =
    typeof value.id === 'string' && value.id.trim().length > 0
      ? value.id
      : randomUUID()
  return {
    id,
    title,
    firstQuestion,
    createdAt,
    updatedAt,
    state,
  }
}

function parseProjectStore(raw: unknown): { store: ProjectStoreState; migrated: boolean } {
  const fallback = createEmptyProjectStoreState()
  if (!isObject(raw)) {
    return { store: fallback, migrated: false }
  }

  if (Array.isArray(raw.chats)) {
    const now = new Date().toISOString()
    const chats = raw.chats
      .map((chat) => normalizeChatRecord(chat, now))
      .filter((chat): chat is ProjectChatRecord => chat !== null)
    const sorted = sortChatRecords(chats)
    const activeChatId =
      typeof raw.activeChatId === 'string' &&
      sorted.some((chat) => chat.id === raw.activeChatId)
        ? raw.activeChatId
        : sorted[0]?.id ?? null
    return {
      store: {
        version: 2,
        chats: sorted,
        activeChatId,
        updatedAt:
          typeof raw.updatedAt === 'string' && raw.updatedAt
            ? raw.updatedAt
            : now,
      },
      migrated: false,
    }
  }

  const now = new Date().toISOString()
  const legacyState = normalizeChatState({
    nodes: raw.nodes as FlowNode[] | undefined,
    edges: raw.edges as FlowEdge[] | undefined,
    chat: raw.chat as ChatMessage[] | undefined,
    autoLayoutLocked: raw.autoLayoutLocked as boolean | undefined,
  })
  const hasLegacyData =
    legacyState.nodes.length > 0 ||
    legacyState.edges.length > 0 ||
    legacyState.chat.length > 0
  if (!hasLegacyData) {
    return { store: fallback, migrated: false }
  }

  const firstQuestion = findFirstUserQuestion(legacyState.chat)
  const createdAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now
  const migratedChat: ProjectChatRecord = {
    id: randomUUID(),
    title: buildChatTitle(firstQuestion),
    firstQuestion,
    createdAt,
    updatedAt: createdAt,
    state: legacyState,
  }
  return {
    store: {
      version: 2,
      chats: [migratedChat],
      activeChatId: migratedChat.id,
      updatedAt: createdAt,
    },
    migrated: true,
  }
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

async function saveProjectStore(projectPath: string, state: ProjectStoreState) {
  const store = await ensureProjectStore(projectPath)
  const chats = sortChatRecords(state.chats).map((chat) => ({
    ...chat,
    state: normalizeChatState(chat.state),
  }))
  const activeChatId =
    state.activeChatId && chats.some((chat) => chat.id === state.activeChatId)
      ? state.activeChatId
      : chats[0]?.id ?? null
  const payload: ProjectStoreState = {
    version: 2,
    chats,
    activeChatId,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(store.statePath, payload)
}

async function loadProjectStoreState(projectPath: string): Promise<ProjectStoreState> {
  const store = await ensureProjectStore(projectPath)
  const raw = await readJsonFile<unknown>(store.statePath, null)
  const parsed = parseProjectStore(raw)
  if (parsed.migrated) {
    await saveProjectStore(projectPath, parsed.store)
  }
  return parsed.store
}

function resolveActiveChat(store: ProjectStoreState): ProjectChatRecord | null {
  const sorted = sortChatRecords(store.chats)
  if (store.activeChatId) {
    const active = sorted.find((chat) => chat.id === store.activeChatId)
    if (active) {
      return active
    }
  }
  return sorted[0] ?? null
}

async function openProject(projectPath: string) {
  await updateRecents(projectPath)
  const store = await loadProjectStoreState(projectPath)
  const activeChat = resolveActiveChat(store)
  if (activeChat && store.activeChatId !== activeChat.id) {
    store.activeChatId = activeChat.id
    await saveProjectStore(projectPath, store)
  }
  return {
    path: projectPath,
    name: path.basename(projectPath),
    activeChatId: activeChat?.id ?? null,
    chats: toChatSummaries(store.chats),
    state: activeChat?.state ?? createEmptyChatState(),
  }
}

const chatStateSchema = z.object({
  version: z.number().optional(),
  nodes: z.array(z.custom<FlowNode>()),
  edges: z.array(z.custom<FlowEdge>()),
  chat: z.array(z.custom<ChatMessage>()).optional(),
  autoLayoutLocked: z.boolean().optional(),
})

export const projectRouter = createTRPCRouter({
  listRecent: baseProcedure.query(async () => readRecents()),
  choose: baseProcedure.mutation(async () => {
    const parentWindow = BrowserWindow.getFocusedWindow()
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  }),
  create: baseProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const root = getDefaultProjectsRoot()
      await fs.mkdir(root, { recursive: true })
      const projectPath = await ensureUniqueProjectPath(root, input.name)
      await fs.mkdir(projectPath, { recursive: true })
      return openProject(projectPath)
    }),
  openDefault: baseProcedure.mutation(async () => {
    const projectPath = getDefaultProjectPath()
    await fs.mkdir(projectPath, { recursive: true })
    return openProject(projectPath)
  }),
  openChat: baseProcedure
    .input(
      z.object({
        path: z.string(),
        chatId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const store = await loadProjectStoreState(input.path)
      const chat = store.chats.find((item) => item.id === input.chatId)
      if (!chat) {
        throw new Error('Chat not found')
      }
      store.activeChatId = chat.id
      await saveProjectStore(input.path, store)
      return {
        chatId: chat.id,
        chats: toChatSummaries(store.chats),
        state: normalizeChatState(chat.state),
      }
    }),
  createChat: baseProcedure
    .input(
      z.object({
        path: z.string(),
        firstQuestion: z.string().min(1),
        state: chatStateSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const store = await loadProjectStoreState(input.path)
      const firstQuestion = normalizeFirstQuestion(input.firstQuestion)
      const now = new Date().toISOString()
      const nextChat: ProjectChatRecord = {
        id: randomUUID(),
        title: buildChatTitle(firstQuestion),
        firstQuestion,
        createdAt: now,
        updatedAt: now,
        state: normalizeChatState({
          nodes: input.state.nodes,
          edges: input.state.edges,
          chat: input.state.chat ?? [],
          autoLayoutLocked: input.state.autoLayoutLocked,
        }),
      }
      store.chats = [...store.chats, nextChat]
      store.activeChatId = nextChat.id
      store.updatedAt = now
      await saveProjectStore(input.path, store)
      return {
        chat: toChatSummary(nextChat),
        chats: toChatSummaries(store.chats),
        activeChatId: nextChat.id,
      }
    }),
  open: baseProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => openProject(input.path)),
  saveState: baseProcedure
    .input(
      z.object({
        path: z.string(),
        chatId: z.string().nullable().optional(),
        state: chatStateSchema,
      }),
    )
    .mutation(async ({ input }) => {
      if (!input.chatId) {
        return { ok: true, chat: null }
      }
      const store = await loadProjectStoreState(input.path)
      const now = new Date().toISOString()
      const nextState = normalizeChatState({
        nodes: input.state.nodes,
        edges: input.state.edges,
        chat: input.state.chat ?? [],
        autoLayoutLocked: input.state.autoLayoutLocked,
      })
      let chat = store.chats.find((item) => item.id === input.chatId)
      if (!chat) {
        const inferredFirstQuestion = findFirstUserQuestion(nextState.chat)
        chat = {
          id: input.chatId,
          title: buildChatTitle(inferredFirstQuestion),
          firstQuestion: inferredFirstQuestion,
          createdAt: now,
          updatedAt: now,
          state: nextState,
        }
        store.chats = [...store.chats, chat]
      } else {
        chat.state = nextState
        chat.updatedAt = now
        if (!chat.firstQuestion) {
          const inferredFirstQuestion = findFirstUserQuestion(nextState.chat)
          if (inferredFirstQuestion) {
            chat.firstQuestion = inferredFirstQuestion
            chat.title = buildChatTitle(inferredFirstQuestion)
          }
        }
      }
      store.activeChatId = chat.id
      store.updatedAt = now
      await saveProjectStore(input.path, store)
      return { ok: true, chat: toChatSummary(chat) }
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
