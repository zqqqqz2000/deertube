import { useMemo, type SyntheticEvent } from "react";
import { ArrowLeftRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { ProjectChatSummary } from "./types";

interface ChatTabActionsProps {
  chats: ProjectChatSummary[];
  activeChatId: string | null;
  busy: boolean;
  onSwitchChat: (chatId: string) => void;
  onCreateChat: () => void;
}

function toTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUpdatedLabel(value: string): string {
  const updatedAt = toTimestamp(value);
  if (!updatedAt) {
    return "1y";
  }
  const diffMs = Date.now() - updatedAt;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;
  if (diffMs < dayMs) {
    return `${Math.max(1, Math.floor(diffMs / hourMs) || 1)}h`;
  }
  if (diffMs < weekMs) {
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d`;
  }
  if (diffMs < monthMs) {
    return `${Math.max(1, Math.floor(diffMs / weekMs))}w`;
  }
  if (diffMs < yearMs) {
    return `${Math.max(1, Math.floor(diffMs / monthMs))}m`;
  }
  return `${Math.max(1, Math.floor(diffMs / yearMs))}y`;
}

export function ChatTabActions({
  chats,
  activeChatId,
  busy,
  onSwitchChat,
  onCreateChat,
}: ChatTabActionsProps) {
  const sortedChats = useMemo(
    () =>
      [...chats].sort(
        (left, right) =>
          toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
      ),
    [chats],
  );
  const switchDisabled = busy;
  const stopHeaderEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      className="ml-1 flex items-center gap-1"
      onMouseDown={stopHeaderEvent}
      onClick={stopHeaderEvent}
      onDoubleClick={stopHeaderEvent}
    >
      <Select
        value={activeChatId ?? undefined}
        onValueChange={onSwitchChat}
        disabled={switchDisabled}
      >
        <SelectTrigger
          className="h-6 w-6 shrink-0 justify-center rounded-full border-0 bg-transparent p-0 text-foreground/80 shadow-none hover:bg-accent/50 [&>svg:last-child]:hidden"
          aria-label="Switch chat"
          title="Switch chat"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="center"
          sideOffset={6}
          className="max-h-72 w-[260px]"
        >
          {sortedChats.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No saved chats yet.
            </div>
          ) : (
            sortedChats.map((chat) => (
              <SelectItem
                key={chat.id}
                value={chat.id}
                className="pr-8"
                title={chat.title}
              >
                <div className="flex w-full min-w-0 items-center gap-3">
                  <span className="flex-1 truncate text-sm text-foreground">
                    {chat.title}
                  </span>
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {formatUpdatedLabel(chat.updatedAt)}
                  </span>
                </div>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 rounded-full border-0 bg-transparent text-foreground/80 shadow-none hover:bg-accent/50"
        aria-label="Create chat"
        title="Create chat"
        onClick={onCreateChat}
        disabled={busy}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
