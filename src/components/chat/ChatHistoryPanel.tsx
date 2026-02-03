import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "../../types/chat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Chat } from "@/modules/chat/components/chat";
import { ChatMessages } from "@/modules/chat/components/chat-messages";
import {
  ChatEvent,
  ChatEventBody,
  ChatEventContent,
  ChatEventDescription,
  ChatEventTitle,
} from "@/modules/chat/components/chat-event";
import { PrimaryMessage } from "@/modules/chat/components/primary-message";
import { AdditionalMessage } from "@/modules/chat/components/additional-message";
import { DateItem } from "@/modules/chat/components/date-item";
import {
  ChatToolbar,
  ChatToolbarAddonEnd,
  ChatToolbarTextarea,
} from "@/modules/chat/components/chat-toolbar";

interface ChatHistoryPanelProps {
  messages: ChatMessage[];
  selectedResponseId: string | null;
  input: string;
  busy: boolean;
  graphBusy?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
}

export default function ChatHistoryPanel({
  messages,
  selectedResponseId,
  input,
  busy,
  graphBusy = false,
  onInputChange,
  onSend,
}: ChatHistoryPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const highlightedId = selectedResponseId;
  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [messages],
  );

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (!highlightedId) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      return;
    }
    const target = scrollRef.current.querySelector<HTMLElement>(
      `[data-message-id="${highlightedId}"]`,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedId, sortedMessages.length]);

  const chatItems = useMemo(() => {
    const items: Array<
      | { kind: "date"; id: string; timestamp: number }
      | { kind: "primary"; id: string; message: ChatMessage }
      | { kind: "additional"; id: string; message: ChatMessage }
    > = [];
    let lastDateKey = "";
    let lastRole: ChatMessage["role"] | null = null;

    sortedMessages.forEach((message) => {
      const timestamp = new Date(message.createdAt).getTime();
      const dateKey = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(timestamp);

      if (dateKey !== lastDateKey) {
        items.push({
          kind: "date",
          id: `date-${dateKey}`,
          timestamp,
        });
        lastDateKey = dateKey;
        lastRole = null;
      }

      if (lastRole === message.role) {
        items.push({ kind: "additional", id: message.id, message });
      } else {
        items.push({ kind: "primary", id: message.id, message });
        lastRole = message.role;
      }
    });

    return items;
  }, [sortedMessages]);

  return (
    <div className="pointer-events-auto absolute left-4 top-20 z-20 w-[380px]">
      <div className="flex max-h-[78vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-background/90 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
          <span>History</span>
          <span className="text-[10px] font-semibold text-muted-foreground/70">
            {messages.length} MSG
          </span>
        </div>
        <Chat>
          <ChatMessages ref={scrollRef} className="gap-2 px-2">
            {messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
                Ask a question to build the conversation.
              </div>
            ) : (
              chatItems.map((item) => {
                if (item.kind === "date") {
                  return <DateItem key={item.id} timestamp={item.timestamp} />;
                }
                const message = item.message;
                const timestamp = new Date(message.createdAt).getTime();
                const isUser = message.role === "user";
                const isHighlighted = message.id === highlightedId;
                const content = (
                  <div
                    className={cn(
                      "rounded-md px-3 py-2",
                      isUser ? "bg-muted text-foreground" : "bg-secondary text-foreground",
                      isHighlighted && "ring-2 ring-amber-400/60"
                    )}
                  >
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                      {message.content}
                    </pre>
                  </div>
                );
                if (item.kind === "primary") {
                  return (
                    <div key={item.id} data-message-id={message.id}>
                      <PrimaryMessage
                        senderName={isUser ? "You" : "Assistant"}
                        avatarFallback={isUser ? "U" : "A"}
                        content={content}
                        timestamp={timestamp}
                      />
                    </div>
                  );
                }
                return (
                  <div key={item.id} data-message-id={message.id}>
                    <AdditionalMessage content={content} timestamp={timestamp} />
                  </div>
                );
              })
            )}
            {graphBusy && (
              <ChatEvent className="items-start gap-2 px-2">
                <ChatEventBody>
                  <ChatEventTitle className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Function Call
                  </ChatEventTitle>
                  <ChatEventContent>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                      graph.run()
                    </div>
                  </ChatEventContent>
                  <ChatEventDescription>Applying graph updates</ChatEventDescription>
                </ChatEventBody>
              </ChatEvent>
            )}
            {busy && (
              <PrimaryMessage
                senderName="Assistant"
                avatarFallback="A"
                content={
                  <div className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
                    Thinking...
                  </div>
                }
                timestamp={Date.now()}
              />
            )}
          </ChatMessages>
          <ChatToolbar>
            <ChatToolbarTextarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder="Ask a question..."
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
            />
            <ChatToolbarAddonEnd>
              <Button
                size="sm"
                className="h-9 rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={onSend}
                disabled={busy || !input.trim()}
              >
                {busy ? "..." : "Send"}
              </Button>
            </ChatToolbarAddonEnd>
          </ChatToolbar>
        </Chat>
      </div>
    </div>
  );
}
