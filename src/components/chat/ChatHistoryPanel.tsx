import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../types/chat";
import type {
  FlowNode,
  InsightNodeData,
  QuestionNodeData,
  SourceNodeData,
} from "../../types/flow";
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
  selectedNode?: FlowNode | null;
  onFocusNode?: (nodeId: string) => void;
  collapseSignal?: number;
  input: string;
  busy: boolean;
  graphBusy?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onRetry?: (messageId: string) => void;
}

export default function ChatHistoryPanel({
  messages,
  selectedResponseId,
  selectedNode,
  onFocusNode,
  collapseSignal = 0,
  input,
  busy,
  graphBusy = false,
  onInputChange,
  onSend,
  onRetry,
}: ChatHistoryPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const resizeOffset = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    mode: "x" | "y" | "both";
  } | null>(null);
  const highlightedId = selectedResponseId;
  const [panelPosition, setPanelPosition] = useState({ x: 16, y: 80 });
  const [panelSize, setPanelSize] = useState(() => ({
    width: 380,
    height:
      typeof window === "undefined"
        ? 560
        : Math.round(window.innerHeight * 0.78),
  }));
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isPinned, setIsPinned] = useState(true);
  const collapsedSize = useMemo(() => ({ width: 170, height: 56 }), []);
  const expandedSize = panelSize;
  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [messages],
  );
  const selectedSummary = useMemo(() => {
    if (!selectedNode) {
      return null;
    }
    if (selectedNode.type === "insight") {
      const data = selectedNode.data as InsightNodeData;
      if (data.responseId === "" && data.titleShort === "Start") {
        return null;
      }
      return {
        id: selectedNode.id,
        title: data.titleShort || data.titleLong,
        subtitle: data.excerpt,
        kind: "Insight",
      };
    }
    if (selectedNode.type === "source") {
      const data = selectedNode.data as SourceNodeData;
      return {
        id: selectedNode.id,
        title: data.title,
        subtitle: data.snippet ?? data.url,
        kind: "Source",
      };
    }
    if (selectedNode.type === "question") {
      const data = selectedNode.data as QuestionNodeData;
      return {
        id: selectedNode.id,
        title: data.question,
        subtitle: data.answer,
        kind: "Q/A",
      };
    }
    return null;
  }, [selectedNode]);
  const handleFocusNode = useCallback(() => {
    if (!selectedSummary?.id || !onFocusNode) {
      return;
    }
    onFocusNode(selectedSummary.id);
  }, [onFocusNode, selectedSummary]);

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

  useEffect(() => {
    if (collapseSignal === 0) {
      return;
    }
    setIsPinned(false);
    setIsCollapsed(true);
  }, [collapseSignal]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    dragOffset.current = {
      x: event.clientX - panelPosition.x,
      y: event.clientY - panelPosition.y,
    };
    target.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOffset.current) {
      return;
    }
    setPanelPosition({
      x: Math.max(0, event.clientX - dragOffset.current.x),
      y: Math.max(0, event.clientY - dragOffset.current.y),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleResizePointerDown =
    (mode: "x" | "y" | "both") => (event: React.PointerEvent<HTMLDivElement>) => {
      if (isCollapsed) {
        return;
      }
      event.stopPropagation();
      resizeOffset.current = {
        x: event.clientX,
        y: event.clientY,
        width: panelSize.width,
        height: panelSize.height,
        mode,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeOffset.current) {
      return;
    }
    const maxWidth =
      typeof window === "undefined"
        ? 720
        : Math.max(360, window.innerWidth - 40);
    const maxHeight =
      typeof window === "undefined"
        ? 760
        : Math.max(320, Math.round(window.innerHeight * 0.9));
    const minWidth = 320;
    const minHeight = 320;
    const deltaX = event.clientX - resizeOffset.current.x;
    const deltaY = event.clientY - resizeOffset.current.y;
    const nextWidth =
      resizeOffset.current.mode === "y"
        ? resizeOffset.current.width
        : Math.min(
            maxWidth,
            Math.max(minWidth, resizeOffset.current.width + deltaX),
          );
    const nextHeight =
      resizeOffset.current.mode === "x"
        ? resizeOffset.current.height
        : Math.min(
            maxHeight,
            Math.max(minHeight, resizeOffset.current.height + deltaY),
          );
    setPanelSize({ width: nextWidth, height: nextHeight });
  };

  const handleResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeOffset.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handlePanelMouseEnter = () => {
    if (!isPinned && isCollapsed) {
      setIsCollapsed(false);
    }
  };

  const handlePanelMouseLeave = () => {
    if (!isPinned) {
      setIsCollapsed(true);
    }
  };

  const handlePanelInteract = () => {
    if (!isPinned) {
      setIsPinned(true);
    }
    if (isCollapsed) {
      setIsCollapsed(false);
    }
  };

  const chatItems = useMemo(() => {
    const items: (
      | { kind: "date"; id: string; timestamp: number }
      | { kind: "primary"; id: string; message: ChatMessage }
      | { kind: "additional"; id: string; message: ChatMessage }
    )[] = [];
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
  const hasPendingAssistant = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "assistant" && message.status === "pending",
      ),
    [messages],
  );

  return (
    <div
      className="pointer-events-auto absolute z-20 transition-[width,height] duration-200"
      style={{
        left: panelPosition.x,
        top: panelPosition.y,
        width: isCollapsed ? collapsedSize.width : expandedSize.width,
        height: isCollapsed ? collapsedSize.height : expandedSize.height,
      }}
      onMouseEnter={handlePanelMouseEnter}
      onMouseLeave={handlePanelMouseLeave}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-background/90 shadow-2xl shadow-black/40 backdrop-blur transition-[width,height] duration-200"
        onPointerDown={handlePanelInteract}
        onWheel={handlePanelInteract}
        onFocusCapture={handlePanelInteract}
      >
        {isCollapsed ? (
          <div className="flex h-full items-center justify-between px-4 text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
            <span>Chat</span>
            <span className="text-[10px] font-semibold text-muted-foreground/70">
              {messages.length}
            </span>
          </div>
        ) : (
          <>
        <div
          className="flex cursor-move items-center justify-between border-b border-border px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-muted-foreground"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <span>Explore</span>
          <span className="text-[10px] font-semibold text-muted-foreground/70">
            {messages.length} MSG
          </span>
        </div>
        {selectedSummary && (
          <button
            type="button"
            className="mx-3 mt-3 flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:border-white/25 hover:bg-white/10"
            onClick={handleFocusNode}
          >
            <div className="mt-1 h-2.5 w-2.5 rounded-full bg-amber-400/80 shadow-[0_0_12px_rgba(251,191,36,0.45)]" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
                Selected {selectedSummary.kind}
              </div>
              <div className="truncate text-sm font-semibold text-foreground">
                {selectedSummary.title}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {selectedSummary.subtitle}
              </div>
            </div>
          </button>
        )}
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
                const isFailed = message.status === "failed";
                const displayContent =
                  !isUser && message.status === "pending" && !message.content
                    ? "Thinking..."
                    : message.content;
                const content = (
                  <div
                    className={cn(
                      "rounded-md px-3 py-2",
                      isUser
                        ? "bg-muted text-foreground"
                        : "bg-secondary text-foreground",
                      isFailed &&
                        "border border-destructive/40 bg-destructive/10 text-destructive",
                      isHighlighted && "ring-2 ring-amber-400/60",
                    )}
                  >
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                      {displayContent}
                    </pre>
                    {!isUser && isFailed && onRetry && (
                      <div className="mt-3 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => onRetry(message.id)}
                        >
                          Retry
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {message.error ?? "Request failed"}
                        </span>
                      </div>
                    )}
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
                    <AdditionalMessage
                      content={content}
                      timestamp={timestamp}
                    />
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
                  <ChatEventDescription>
                    Applying graph updates
                  </ChatEventDescription>
                </ChatEventBody>
              </ChatEvent>
            )}
            {busy && !hasPendingAssistant && (
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
          </>
        )}
      </div>
      {!isCollapsed && (
      <div
        className="absolute right-0 top-10 h-[calc(100%-40px)] w-1 cursor-ew-resize"
        onPointerDown={handleResizePointerDown("x")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
      />
      )}
      {!isCollapsed && (
      <div
        className="absolute bottom-0 left-6 h-1 w-[calc(100%-24px)] cursor-ns-resize"
        onPointerDown={handleResizePointerDown("y")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
      />
      )}
      {!isCollapsed && (
      <div
        className="absolute bottom-1 right-1 h-4 w-4 cursor-se-resize rounded-full border border-white/30 bg-white/10"
        onPointerDown={handleResizePointerDown("both")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
      />
      )}
    </div>
  );
}
