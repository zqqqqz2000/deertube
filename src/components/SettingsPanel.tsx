import type { ProviderProfile } from '../lib/settings'
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
  return (
    <Sheet open={open} onOpenChange={(value) => (!value ? onClose() : undefined)}>
      <SheetContent
        side="right"
        className="flex h-full w-full max-w-none flex-col gap-0 border-border/70 bg-card/95 text-foreground sm:max-w-[760px] md:max-w-[900px] lg:max-w-[1040px]"
      >
        <SheetHeader className="border-b border-border/70 pb-4">
          <SheetTitle className="text-foreground">Providers & Graph</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Configure Jina, Tavily, and LLM settings. Profiles are stored in localStorage.
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
                  Configure provider and model details.
                </div>
              </div>
              <Button
                className="bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 text-slate-900 shadow-lg shadow-orange-500/30"
                onClick={onProfileAdd}
              >
                Add profile
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-6">
              {profiles.map((profile) => (
                <div key={profile.id} className="space-y-4">
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

                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                      LLM
                    </div>
                    <div className="grid gap-2">
                      <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Provider
                      </Label>
                      <Input
                        className="border-border/70 bg-background/70 text-foreground"
                        value={profile.llmProvider}
                        onChange={(event) =>
                          onProfileChange(profile.id, { llmProvider: event.target.value })
                        }
                        placeholder="openai"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Model ID
                      </Label>
                      <Input
                        className="border-border/70 bg-background/70 text-foreground"
                        value={profile.llmModelId}
                        onChange={(event) =>
                          onProfileChange(profile.id, { llmModelId: event.target.value })
                        }
                        placeholder="gpt-4o-mini"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        API Key (optional)
                      </Label>
                      <Input
                        className="border-border/70 bg-background/70 text-foreground"
                        value={profile.llmApiKey}
                        onChange={(event) =>
                          onProfileChange(profile.id, { llmApiKey: event.target.value })
                        }
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Base URL
                      </Label>
                      <Input
                        className="border-border/70 bg-background/70 text-foreground"
                        value={profile.llmBaseUrl}
                        onChange={(event) =>
                          onProfileChange(profile.id, { llmBaseUrl: event.target.value })
                        }
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
