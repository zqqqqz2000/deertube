export interface ProviderProfile {
  id: string
  name: string
  tavilyApiKey: string
  jinaReaderBaseUrl: string
  jinaReaderApiKey: string
  llmProvider: string
  llmModelId: string
  llmApiKey: string
  llmBaseUrl: string
}

const PROFILES_KEY = 'deertube:profiles'
const ACTIVE_BY_PROJECT_KEY = 'deertube:activeProfileByProject'

const createDefaultProfile = (): ProviderProfile => ({
  id: crypto.randomUUID(),
  name: 'Default',
  tavilyApiKey: '',
  jinaReaderBaseUrl: 'https://r.jina.ai/',
  jinaReaderApiKey: '',
  llmProvider: 'openai',
  llmModelId: 'gpt-4o-mini',
  llmApiKey: '',
  llmBaseUrl: '',
})

const normalizeProfile = (raw: Partial<ProviderProfile>): ProviderProfile => {
  const defaults = createDefaultProfile()
  return {
    id: raw.id ?? defaults.id,
    name: raw.name ?? defaults.name,
    tavilyApiKey: raw.tavilyApiKey ?? '',
    jinaReaderBaseUrl: raw.jinaReaderBaseUrl ?? defaults.jinaReaderBaseUrl,
    jinaReaderApiKey: raw.jinaReaderApiKey ?? '',
    llmProvider: raw.llmProvider ?? defaults.llmProvider,
    llmModelId: raw.llmModelId ?? defaults.llmModelId,
    llmApiKey: raw.llmApiKey ?? '',
    llmBaseUrl: raw.llmBaseUrl ?? '',
  }
}

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  }
  catch {
    return fallback
  }
}

export const loadProfiles = (): ProviderProfile[] => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [createDefaultProfile()]
  }
  const stored = safeParse<Partial<ProviderProfile>[]>(
    window.localStorage.getItem(PROFILES_KEY),
    [],
  )
  const profiles = Array.isArray(stored) ? stored.map(normalizeProfile) : []
  if (profiles.length === 0) {
    const defaults = [createDefaultProfile()]
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(defaults))
    return defaults
  }
  return profiles
}

export const saveProfiles = (profiles: ProviderProfile[]) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
}

export const loadActiveProfileId = (projectPath: string): string | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const mapping = safeParse<Record<string, string>>(
    window.localStorage.getItem(ACTIVE_BY_PROJECT_KEY),
    {},
  )
  return mapping[projectPath] ?? null
}

export const saveActiveProfileId = (projectPath: string, profileId: string | null) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const mapping = safeParse<Record<string, string>>(
    window.localStorage.getItem(ACTIVE_BY_PROJECT_KEY),
    {},
  )
  if (profileId) {
    mapping[projectPath] = profileId
  } else {
    delete mapping[projectPath]
  }
  window.localStorage.setItem(ACTIVE_BY_PROJECT_KEY, JSON.stringify(mapping))
}

export const ensureActiveProfileId = (
  projectPath: string,
  profiles: ProviderProfile[],
  currentId: string | null,
): string | null => {
  if (profiles.length === 0) {
    return null
  }
  const exists = currentId && profiles.some((profile) => profile.id === currentId)
  if (exists) {
    return currentId
  }
  const fallback = profiles[0]?.id ?? null
  if (fallback) {
    saveActiveProfileId(projectPath, fallback)
  }
  return fallback
}

export const createProfileDraft = (name: string): ProviderProfile => ({
  ...createDefaultProfile(),
  name,
})
