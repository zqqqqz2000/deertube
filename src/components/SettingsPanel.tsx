import type { ProviderProfile } from '../lib/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

type SettingsPanelProps = {
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
        className="flex h-full w-full max-w-none flex-col gap-0 border-white/10 bg-slate-950/95 text-white sm:max-w-[760px] md:max-w-[900px] lg:max-w-[1040px]"
      >
        <SheetHeader className="border-b border-white/10 pb-4">
          <SheetTitle className="text-white">Providers & Graph</SheetTitle>
          <SheetDescription className="text-white/60">
            Configure Jina, Tavily, and LLM settings. Profiles are stored in localStorage.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="px-2 py-6 sm:px-6">
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-[0.3em] text-white/60">
                  Graph settings
                </CardTitle>
                <CardDescription className="text-white/60">
                  Choose the active profile for this graph.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label className="text-xs uppercase tracking-[0.2em] text-white/50">
                    Active profile
                  </Label>
                  <Select
                    value={activeProfileId ?? ''}
                    onValueChange={(value) => onActiveProfileChange(value)}
                  >
                    <SelectTrigger className="h-10 border-white/10 bg-slate-900/70 text-white">
                      <SelectValue placeholder="Choose profile" />
                    </SelectTrigger>
                    <SelectContent className="border-white/10 bg-slate-900 text-white">
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
              </CardContent>
            </Card>

            <Separator className="my-6 bg-white/10" />

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-white/50">Profiles</div>
                <div className="mt-1 text-sm text-white/70">
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

            <div className="mt-4 flex flex-col gap-5">
              {profiles.map((profile) => (
                <Card key={profile.id} className="border-white/10 bg-slate-900/70 text-white">
                  <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
                    <div className="text-sm font-semibold">
                      {profile.name}
                      {activeProfileId === profile.id && (
                        <Badge variant="secondary" className="ml-2 border border-emerald-400/40 bg-emerald-500/10 text-emerald-200">
                          Active
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-400/40 text-red-200 hover:bg-red-500/10 hover:text-red-200"
                      onClick={() => onProfileDelete(profile.id)}
                      disabled={profiles.length <= 1}
                    >
                      Delete
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">Name</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.name}
                          onChange={(event) => onProfileChange(profile.id, { name: event.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">Tavily API Key</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.tavilyApiKey}
                          onChange={(event) => onProfileChange(profile.id, { tavilyApiKey: event.target.value })}
                          placeholder="tvly-..."
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">Jina Reader Base URL</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.jinaReaderBaseUrl}
                          onChange={(event) =>
                            onProfileChange(profile.id, { jinaReaderBaseUrl: event.target.value })
                          }
                          placeholder="https://r.jina.ai/"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">LLM Provider</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.llmProvider}
                          onChange={(event) => onProfileChange(profile.id, { llmProvider: event.target.value })}
                          placeholder="openai"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">LLM Model ID</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.llmModelId}
                          onChange={(event) => onProfileChange(profile.id, { llmModelId: event.target.value })}
                          placeholder="gpt-4o-mini"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">LLM API Key (optional)</Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.llmApiKey}
                          onChange={(event) => onProfileChange(profile.id, { llmApiKey: event.target.value })}
                          placeholder="sk-..."
                        />
                      </div>
                      <div className="grid gap-2 md:col-span-2">
                        <Label className="text-xs uppercase tracking-[0.2em] text-white/50">
                          LLM Base URL
                        </Label>
                        <Input
                          className="border-white/10 bg-white/5 text-white"
                          value={profile.llmBaseUrl}
                          onChange={(event) => onProfileChange(profile.id, { llmBaseUrl: event.target.value })}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
