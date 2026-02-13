import type {
  LlmModelConfig,
  LlmUsageConfig,
  ProviderProfile,
} from '../lib/settings'
import { ensureValidLlmUsage } from '../lib/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

interface SettingsPanelProps {
  open: boolean
  profiles: ProviderProfile[]
  activeProfileId: string | null
  onClose: () => void
  onActiveProfileChange: (id: string) => void
  onProfileAdd: () => void
  onProfileDelete: (id: string) => void
  onProfileChange: (id: string, patch: Partial<ProviderProfile>) => void
}

const PURPOSE_FIELDS: { key: keyof LlmUsageConfig, label: string }[] = [
  { key: 'chat', label: 'Chat model' },
  { key: 'search', label: 'Search model' },
  { key: 'extract', label: 'Extract model' },
  { key: 'graph', label: 'Graph model' },
]

const createProviderDraft = (index: number) => ({
  id: crypto.randomUUID(),
  name: `Provider ${index}`,
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
})

const createModelDraft = (providerId: string, index: number): LlmModelConfig => ({
  id: crypto.randomUUID(),
  name: `Model ${index}`,
  providerId,
  modelId: 'gpt-4o-mini',
})

const formatModelLabel = (
  model: LlmModelConfig,
  providerNameById: Map<string, string>,
) => {
  const providerName = providerNameById.get(model.providerId) ?? 'Provider'
  return `${model.name} (${providerName} · ${model.modelId})`
}

export default function SettingsPanel({
  open,
  profiles,
  activeProfileId,
  onClose,
  onActiveProfileChange,
  onProfileAdd,
  onProfileDelete,
  onProfileChange,
}: SettingsPanelProps) {
  const handleProviderDelete = (profile: ProviderProfile, providerId: string) => {
    if (profile.llmProviders.length <= 1) {
      return
    }
    const nextProviders = profile.llmProviders.filter((provider) => provider.id !== providerId)
    const providerIds = new Set(nextProviders.map((provider) => provider.id))
    let nextModels = profile.llmModels.filter((model) => providerIds.has(model.providerId))
    if (nextModels.length === 0) {
      const fallbackProviderId = nextProviders[0]?.id
      if (!fallbackProviderId) {
        return
      }
      nextModels = [createModelDraft(fallbackProviderId, 1)]
    }
    const nextUsage = ensureValidLlmUsage(profile.llmUsage, nextModels)
    onProfileChange(profile.id, {
      llmProviders: nextProviders,
      llmModels: nextModels,
      llmUsage: nextUsage,
    })
  }

  const handleModelDelete = (profile: ProviderProfile, modelId: string) => {
    if (profile.llmModels.length <= 1) {
      return
    }
    const nextModels = profile.llmModels.filter((model) => model.id !== modelId)
    const nextUsage = ensureValidLlmUsage(profile.llmUsage, nextModels)
    onProfileChange(profile.id, {
      llmModels: nextModels,
      llmUsage: nextUsage,
    })
  }

  const handleModelChange = (
    profile: ProviderProfile,
    modelId: string,
    patch: Partial<LlmModelConfig>,
  ) => {
    const nextModels = profile.llmModels.map((model) =>
      model.id === modelId ? { ...model, ...patch } : model,
    )
    const nextUsage = ensureValidLlmUsage(profile.llmUsage, nextModels)
    onProfileChange(profile.id, {
      llmModels: nextModels,
      llmUsage: nextUsage,
    })
  }

  return (
    <Sheet open={open} onOpenChange={(value) => (!value ? onClose() : undefined)}>
      <SheetContent
        side="right"
        className="flex h-full w-full max-w-none flex-col gap-0 border-border/70 bg-card/95 text-foreground sm:max-w-[760px] md:max-w-[920px] lg:max-w-[1080px]"
      >
        <SheetHeader className="border-b border-border/70 pb-4">
          <SheetTitle className="text-foreground">Providers & Models</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Providers, models, and model-purpose bindings are saved in localStorage.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="px-2 py-6 sm:px-6">
            <div className="space-y-3">
              <div>
                <div className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
                  Graph settings
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Choose the active profile for this graph.
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Active profile
                </Label>
                <Select
                  value={activeProfileId ?? ''}
                  onValueChange={(value) => onActiveProfileChange(value)}
                >
                  <SelectTrigger className="h-10 border-border/70 bg-background/80 text-foreground">
                    <SelectValue placeholder="Choose profile" />
                  </SelectTrigger>
                  <SelectContent className="border-border/70 bg-card text-foreground">
                    {profiles.length === 0 ? (
                      <SelectItem value="" disabled>
                        No profiles yet
                      </SelectItem>
                    ) : (
                      profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator className="my-6 bg-border/70" />

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                  Profiles
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Configure providers, models, and purpose bindings.
                </div>
              </div>
              <Button
                variant="outline"
                className="border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                onClick={onProfileAdd}
              >
                Add Profile
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-8">
              {profiles.map((profile) => {
                const providerNameById = new Map(
                  profile.llmProviders.map((provider) => [provider.id, provider.name]),
                )
                const fallbackModelId = profile.llmModels[0]?.id ?? ''
                return (
                  <div key={profile.id} className="space-y-5 rounded-xl border border-border/60 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="text-sm font-semibold">
                        {profile.name}
                        {activeProfileId === profile.id && (
                          <Badge
                            variant="secondary"
                            className="ml-2 border border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-200"
                          >
                            Active
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10"
                        onClick={() => onProfileDelete(profile.id)}
                        disabled={profiles.length <= 1}
                      >
                        Delete
                      </Button>
                    </div>

                    <div className="grid gap-2">
                      <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Name
                      </Label>
                      <Input
                        className="border-border/70 bg-background/70 text-foreground"
                        value={profile.name}
                        onChange={(event) => onProfileChange(profile.id, { name: event.target.value })}
                      />
                    </div>

                    <Separator className="bg-border/70" />

                    <div className="space-y-3">
                      <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                        Jina
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                          Reader Base URL
                        </Label>
                        <Input
                          className="border-border/70 bg-background/70 text-foreground"
                          value={profile.jinaReaderBaseUrl}
                          onChange={(event) =>
                            onProfileChange(profile.id, { jinaReaderBaseUrl: event.target.value })
                          }
                          placeholder="https://r.jina.ai/"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                          Reader Token (optional)
                        </Label>
                        <Input
                          className="border-border/70 bg-background/70 text-foreground"
                          value={profile.jinaReaderApiKey}
                          onChange={(event) =>
                            onProfileChange(profile.id, { jinaReaderApiKey: event.target.value })
                          }
                          placeholder="jina_..."
                        />
                      </div>
                    </div>

                    <Separator className="bg-border/70" />

                    <div className="space-y-3">
                      <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                        Tavily
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                          API Key
                        </Label>
                        <Input
                          className="border-border/70 bg-background/70 text-foreground"
                          value={profile.tavilyApiKey}
                          onChange={(event) =>
                            onProfileChange(profile.id, { tavilyApiKey: event.target.value })
                          }
                          placeholder="tvly-..."
                        />
                      </div>
                    </div>

                    <Separator className="bg-border/70" />

                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                            LLM Providers
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Fill provider name/key/base URL once, then reuse in models.
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            onProfileChange(profile.id, {
                              llmProviders: [
                                ...profile.llmProviders,
                                createProviderDraft(profile.llmProviders.length + 1),
                              ],
                            })
                          }
                        >
                          Add provider
                        </Button>
                      </div>
                      <div className="space-y-3">
                        {profile.llmProviders.map((provider) => (
                          <div key={provider.id} className="space-y-3 rounded-lg border border-border/60 p-3">
                            <div className="flex justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                                disabled={profile.llmProviders.length <= 1}
                                onClick={() => handleProviderDelete(profile, provider.id)}
                              >
                                Delete provider
                              </Button>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Alias
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={provider.name}
                                  onChange={(event) =>
                                    onProfileChange(profile.id, {
                                      llmProviders: profile.llmProviders.map((item) =>
                                        item.id === provider.id
                                          ? { ...item, name: event.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                  placeholder="OpenAI Prod"
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Provider ID
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={provider.provider}
                                  onChange={(event) =>
                                    onProfileChange(profile.id, {
                                      llmProviders: profile.llmProviders.map((item) =>
                                        item.id === provider.id
                                          ? { ...item, provider: event.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                  placeholder="openai"
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  API Key (optional)
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={provider.apiKey}
                                  onChange={(event) =>
                                    onProfileChange(profile.id, {
                                      llmProviders: profile.llmProviders.map((item) =>
                                        item.id === provider.id
                                          ? { ...item, apiKey: event.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                  placeholder="sk-..."
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Base URL (optional)
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={provider.baseUrl}
                                  onChange={(event) =>
                                    onProfileChange(profile.id, {
                                      llmProviders: profile.llmProviders.map((item) =>
                                        item.id === provider.id
                                          ? { ...item, baseUrl: event.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                  placeholder="https://api.openai.com/v1"
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <Separator className="bg-border/70" />

                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                            LLM Models
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Each model references one provider.
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const fallbackProviderId = profile.llmProviders[0]?.id
                            if (!fallbackProviderId) {
                              return
                            }
                            const nextModels = [
                              ...profile.llmModels,
                              createModelDraft(fallbackProviderId, profile.llmModels.length + 1),
                            ]
                            onProfileChange(profile.id, {
                              llmModels: nextModels,
                              llmUsage: ensureValidLlmUsage(profile.llmUsage, nextModels),
                            })
                          }}
                        >
                          Add model
                        </Button>
                      </div>
                      <div className="space-y-3">
                        {profile.llmModels.map((model) => (
                          <div key={model.id} className="space-y-3 rounded-lg border border-border/60 p-3">
                            <div className="flex justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                                disabled={profile.llmModels.length <= 1}
                                onClick={() => handleModelDelete(profile, model.id)}
                              >
                                Delete model
                              </Button>
                            </div>
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Alias
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={model.name}
                                  onChange={(event) =>
                                    handleModelChange(profile, model.id, { name: event.target.value })
                                  }
                                  placeholder="GPT-4o mini"
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Provider
                                </Label>
                                <Select
                                  value={model.providerId}
                                  onValueChange={(value) =>
                                    handleModelChange(profile, model.id, { providerId: value })
                                  }
                                >
                                  <SelectTrigger className="h-10 border-border/70 bg-background/80 text-foreground">
                                    <SelectValue placeholder="Choose provider" />
                                  </SelectTrigger>
                                  <SelectContent className="border-border/70 bg-card text-foreground">
                                    {profile.llmProviders.map((provider) => (
                                      <SelectItem key={provider.id} value={provider.id}>
                                        {provider.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Model ID
                                </Label>
                                <Input
                                  className="border-border/70 bg-background/70 text-foreground"
                                  value={model.modelId}
                                  onChange={(event) =>
                                    handleModelChange(profile, model.id, { modelId: event.target.value })
                                  }
                                  placeholder="gpt-4o-mini"
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <Separator className="bg-border/70" />

                    <div className="space-y-3">
                      <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                        Model usage bindings
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {PURPOSE_FIELDS.map((purpose) => (
                          <div key={purpose.key} className="grid gap-2">
                            <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                              {purpose.label}
                            </Label>
                            <Select
                              value={profile.llmUsage[purpose.key] || fallbackModelId}
                              onValueChange={(value) =>
                                onProfileChange(profile.id, {
                                  llmUsage: ensureValidLlmUsage(
                                    { ...profile.llmUsage, [purpose.key]: value },
                                    profile.llmModels,
                                  ),
                                })
                              }
                            >
                              <SelectTrigger className="h-10 border-border/70 bg-background/80 text-foreground">
                                <SelectValue placeholder="Choose model" />
                              </SelectTrigger>
                              <SelectContent className="border-border/70 bg-card text-foreground">
                                {profile.llmModels.map((model) => (
                                  <SelectItem key={model.id} value={model.id}>
                                    {formatModelLabel(model, providerNameById)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
