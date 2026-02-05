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
import { MarkdownRenderer } from "@/components/markdown/renderer";
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
import { ArrowDown, ChevronDown } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ChatHistoryPanelProps {
  messages: ChatMessage[];
  selectedResponseId: string | null;
  selectedNode?: FlowNode | null;
  nodes?: FlowNode[];
  onFocusNode?: (nodeId: string) => void;
  scrollToBottomSignal?: number;
  focusSignal?: number;
  onRequestClearSelection?: () => void;
  input: string;
  busy: boolean;
  graphBusy?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onRetry?: (messageId: string) => void;
}

interface GraphToolInput {
  responseId?: string;
  selectedNodeId?: string | null;
  selectedNodeSummary?: string | null;
}

const parseGraphToolInput = (value: unknown): GraphToolInput | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const responseId =
    typeof input.responseId === "string" && input.responseId.length > 0
      ? input.responseId
      : undefined;
  const selectedNodeId =
    typeof input.selectedNodeId === "string" || input.selectedNodeId === null
      ? input.selectedNodeId
      : undefined;
  const selectedNodeSummary =
    typeof input.selectedNodeSummary === "string" || input.selectedNodeSummary === null
      ? input.selectedNodeSummary
      : undefined;
  if (!responseId && selectedNodeId === undefined && selectedNodeSummary === undefined) {
    return null;
  }
  return { responseId, selectedNodeId, selectedNodeSummary };
};

const getGraphToolResponseId = (value: unknown): string | null =>
  parseGraphToolInput(value)?.responseId ?? null;

export default function ChatHistoryPanel({
  messages,
  selectedResponseId,
  selectedNode,
  nodes = [],
  onFocusNode,
  scrollToBottomSignal = 0,
  focusSignal = 0,
  onRequestClearSelection,
  input,
  busy,
  graphBusy = false,
  onInputChange,
  onSend,
  onRetry,
}: ChatHistoryPanelProps) {
  const { scrollRef, contentRef } = useStickToBottom();
  const highlightedId = selectedResponseId;
  const ignoreHighlightRef = useRef(false);
  const nodeLookup = useMemo(() => {
    const map = new Map<string, FlowNode>();
    nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [nodes]);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const sortedMessages = useMemo(() => messages, [messages]);
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
  const selectedExcerpt = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "insight") {
      return "";
    }
    const data = selectedNode.data as InsightNodeData;
    if (data.responseId === "") {
      return "";
    }
    return data.excerpt ?? "";
  }, [selectedNode]);
  const nodeExcerptRefs = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "insight")
        .map((node) => {
          const data = node.data as InsightNodeData;
          return { id: node.id, text: data.excerpt ?? "" };
        })
        .filter((item) => item.text.trim().length > 0),
    [nodes],
  );
  const runningGraphByResponseId = useMemo(() => {
    const running = new Set<string>();
    messages.forEach((message) => {
      if (message.kind !== "graph-event" || message.toolStatus !== "running") {
        return;
      }
      const responseId = getGraphToolResponseId(message.toolInput);
      if (responseId) {
        running.add(responseId);
      }
    });
    return running;
  }, [messages]);
  const handleFocusNode = useCallback(() => {
    if (!selectedSummary?.id || !onFocusNode) {
      return;
    }
    onFocusNode(selectedSummary.id);
  }, [onFocusNode, selectedSummary]);
  const handleNodeLinkClick = useCallback(
    (nodeId: string) => {
      if (!onFocusNode) {
        return;
      }
      onFocusNode(nodeId);
    },
    [onFocusNode],
  );
  const resolveNodeLabel = useCallback(
    (nodeId: string) => {
      const node = nodeLookup.get(nodeId);
      if (!node) {
        return undefined;
      }
      if (node.type === "question") {
        const data = node.data as QuestionNodeData;
        return data.question;
      }
      if (node.type === "source") {
        const data = node.data as SourceNodeData;
        return data.title ?? data.url;
      }
      if (node.type === "insight") {
        const data = node.data as InsightNodeData;
        return data.titleShort ?? data.titleLong ?? data.titleTiny;
      }
      return undefined;
    },
    [nodeLookup],
  );
  const renderUserContent = useCallback(
    (text: string) => {
      const parts: React.ReactNode[] = [];
      const regex = /\[\[node:([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const [raw, nodeId, label] = match;
        const start = match.index;
        if (start > lastIndex) {
          parts.push(text.slice(lastIndex, start));
        }
        const cleanedLabel = label?.trim();
        const resolvedLabel =
          cleanedLabel ??
          resolveNodeLabel(nodeId) ??
          `Node ${nodeId.slice(0, 6)}`;
        parts.push(
          <button
            key={`node-${nodeId}-${start}`}
            type="button"
            onClick={() => handleNodeLinkClick(nodeId)}
            className="mx-1 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary shadow-sm shadow-black/20 transition hover:-translate-y-0.5 hover:border-primary/60 hover:bg-primary/15"
            title={`Focus node ${resolvedLabel}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 shadow-[0_0_8px_rgba(14,165,233,0.6)]" />
            <span className="max-w-[240px] truncate">{resolvedLabel}</span>
          </button>,
        );
        lastIndex = start + raw.length;
      }
      if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
      }
      return parts.length > 0 ? parts : text;
    },
    [handleNodeLinkClick, resolveNodeLabel],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (!scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior,
    });
  }, [scrollRef]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) {
      return;
    }
    const el = scrollRef.current;
    const threshold = 24;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    setIsAtBottom(atBottom);
  }, [scrollRef]);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (highlightedId && !ignoreHighlightRef.current) {
      const target = scrollRef.current.querySelector<HTMLElement>(
        `[data-message-id="${highlightedId}"]`,
      );
      if (target) {
        const excerpt = target.querySelector<HTMLElement>(
          'mark[data-highlight-excerpt="true"]',
        );
        (excerpt ?? target).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
      return;
    }
    ignoreHighlightRef.current = false;
    if (isAtBottom) {
      scrollToBottom("smooth");
    }
  }, [
    highlightedId,
    focusSignal,
    sortedMessages.length,
    isAtBottom,
    scrollRef,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (scrollToBottomSignal === 0) {
      return;
    }
    setIsAtBottom(true);
    ignoreHighlightRef.current = true;
    scrollToBottom("smooth");
  }, [scrollToBottomSignal, scrollToBottom]);

  useEffect(() => {
    handleScroll();
  }, [handleScroll, sortedMessages.length, busy, graphBusy]);

  const chatItems = useMemo(() => {
    const items: (
      | { kind: "date"; id: string; timestamp: number }
      | { kind: "primary"; id: string; message: ChatMessage }
      | { kind: "additional"; id: string; message: ChatMessage }
      | { kind: "graph"; id: string; message: ChatMessage }
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
          id: `date-${dateKey}-${items.length}`,
          timestamp,
        });
        lastDateKey = dateKey;
        lastRole = null;
      }

      if (message.kind === "graph-event") {
        items.push({ kind: "graph", id: message.id, message });
        lastRole = null;
        return;
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
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/85 shadow-2xl shadow-black/25 backdrop-blur">
      {selectedSummary && (
        <button
          type="button"
          className="mx-3 mt-3 flex items-start gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-left transition hover:border-border hover:bg-card/80"
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
        <ChatMessages
          ref={scrollRef}
          className="gap-2 px-2"
          onScroll={handleScroll}
          contentRef={contentRef}
        >
          {messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
              Ask a question to build the conversation.
            </div>
          ) : (
            chatItems.map((item) => {
              if (item.kind === "date") {
                return <DateItem key={item.id} timestamp={item.timestamp} />;
              }
              if (item.kind === "graph") {
                const { message: eventMessage } = item;
                const statusLabel =
                  eventMessage.toolStatus === "running"
                    ? "Running"
                    : eventMessage.toolStatus === "failed"
                      ? "Failed"
                      : "Complete";

                const parseOutputPayload = (value: unknown): unknown => {
                  if (typeof value === "string") {
                    try {
                      return JSON.parse(value) as unknown;
                    } catch {
                      return null;
                    }
                  }
                  return value;
                };

                interface GraphNodeSummary {
                  id?: string;
                  titleShort?: string;
                  titleLong?: string;
                  excerpt?: string;
                }

                interface GraphOutputPayload {
                  nodesAdded?: number;
                  nodes?: GraphNodeSummary[];
                  explanation?: string;
                }

                const isGraphOutputPayload = (
                  value: unknown,
                ): value is GraphOutputPayload => {
                  if (!value || typeof value !== "object") {
                    return false;
                  }
                  if (
                    "nodes" in value &&
                    Array.isArray((value as { nodes?: unknown }).nodes)
                  ) {
                    return true;
                  }
                  if (
                    "nodesAdded" in value &&
                    typeof (value as { nodesAdded?: unknown }).nodesAdded ===
                      "number"
                  ) {
                    return true;
                  }
                  if (
                    "explanation" in value &&
                    typeof (value as { explanation?: unknown }).explanation ===
                      "string"
                  ) {
                    return true;
                  }
                  return false;
                };

                const outputPayloadRaw = parseOutputPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isGraphOutputPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const nodesFromOutput = outputPayload?.nodes ?? [];
                const nodesAdded = outputPayload?.nodesAdded;
                const explanation =
                  typeof outputPayload?.explanation === "string"
                    ? outputPayload.explanation
                    : undefined;
                const graphToolInput = parseGraphToolInput(eventMessage.toolInput);
                const responseId = graphToolInput?.responseId;
                const selectedNodeId = graphToolInput?.selectedNodeId ?? undefined;
                const resolvedLabel = selectedNodeId
                  ? resolveNodeLabel(selectedNodeId)
                  : undefined;
                const selectedLabel = resolvedLabel
                  ? resolvedLabel
                  : selectedNodeId
                    ? `Node ${selectedNodeId.slice(0, 6)}`
                    : undefined;
                const logLines: string[] = [];
                if (eventMessage.toolStatus === "running") {
                  logLines.push("Running graph tool...");
                }
                if (responseId) {
                  logLines.push(`Response ${responseId.slice(0, 8)}`);
                }
                if (selectedLabel) {
                  logLines.push(`Selected ${selectedLabel}`);
                }

                const hasDetails =
                  logLines.length > 0 ||
                  nodesAdded !== undefined ||
                  nodesFromOutput.length > 0 ||
                  !!explanation;

                return (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventBody>
                      <Collapsible defaultOpen={false}>
                        <div className="flex items-center justify-between gap-2">
                          <ChatEventTitle className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            Graph Update
                          </ChatEventTitle>
                          {hasDetails && (
                            <CollapsibleTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground transition-transform data-[state=open]:rotate-180"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                            </CollapsibleTrigger>
                          )}
                        </div>
                        <ChatEventDescription>
                          {eventMessage.error ? eventMessage.error : statusLabel}
                        </ChatEventDescription>
                        {hasDetails && (
                          <CollapsibleContent className="mt-2">
                            <ChatEventContent className="space-y-2">
                              {logLines.length > 0 && (
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  {logLines.map((line, index) => (
                                    <div key={`${item.id}-log-${index}`}>
                                      {line}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {nodesAdded !== undefined && (
                                <div className="text-xs text-muted-foreground">
                                  Added {nodesAdded} node
                                  {nodesAdded === 1 ? "" : "s"}
                                </div>
                              )}
                              {explanation && (
                                <div className="text-xs text-muted-foreground">
                                  {explanation}
                                </div>
                              )}
                              {nodesFromOutput.length > 0 && (
                                <div className="space-y-2">
                                  {nodesFromOutput.map((node, index) => {
                                    const nodeId =
                                      typeof node.id === "string" ? node.id : "";
                                    const title =
                                      typeof node.titleShort === "string"
                                        ? node.titleShort
                                        : typeof node.titleLong === "string"
                                          ? node.titleLong
                                          : "Insight";
                                    const excerpt =
                                      typeof node.excerpt === "string"
                                        ? node.excerpt
                                        : "";
                                    return (
                                      <button
                                        key={nodeId || `${item.id}-${index}`}
                                        type="button"
                                        className="w-full rounded-md border border-border/70 bg-card/60 px-3 py-2 text-left text-xs transition hover:border-border hover:bg-card/80"
                                        onClick={() => {
                                          if (nodeId && onFocusNode) {
                                            onFocusNode(nodeId);
                                          }
                                        }}
                                      >
                                        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                          Node
                                        </div>
                                        <div className="text-sm font-semibold text-foreground">
                                          {title}
                                        </div>
                                        {excerpt && (
                                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                            {excerpt}
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </ChatEventContent>
                          </CollapsibleContent>
                        )}
                      </Collapsible>
                    </ChatEventBody>
                  </ChatEvent>
                );
              }
              const message = item.message;
              const timestamp = new Date(message.createdAt).getTime();
              const isUser = message.role === "user";
              const isHighlighted = message.id === highlightedId;
              const isFailed = message.status === "failed";
              const shouldHighlightExcerpt =
                message.id === selectedResponseId && !!selectedExcerpt;
              const displayContent =
                !isUser && message.status === "pending" && !message.content
                  ? "Thinking..."
                  : message.content;
              const isGraphRunning =
                message.role === "assistant" &&
                runningGraphByResponseId.has(message.id);
              const content = (
                <div
                  className={cn(
                    "rounded-md px-3 py-2",
                    isUser ? "bg-muted text-foreground" : "bg-secondary text-foreground",
                    isFailed &&
                      "border border-destructive/40 bg-destructive/10 text-destructive",
                    isHighlighted && "ring-2 ring-amber-400/60",
                    isGraphRunning && "message-marquee",
                  )}
                >
                  {isUser ? (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {renderUserContent(displayContent ?? "")}
                    </div>
                  ) : (
                    <MarkdownRenderer
                      source={displayContent ?? ""}
                      highlightExcerpt={
                        shouldHighlightExcerpt ? selectedExcerpt : undefined
                      }
                      onNodeLinkClick={handleNodeLinkClick}
                      resolveNodeLabel={resolveNodeLabel}
                      nodeExcerptRefs={nodeExcerptRefs}
                    />
                  )}
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
                  <AdditionalMessage content={content} timestamp={timestamp} />
                </div>
              );
            })
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
        {!isAtBottom && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2">
            <Button
              size="icon"
              variant="outline"
              className="rounded-full shadow-lg"
              onClick={() => {
                onRequestClearSelection?.();
                setIsAtBottom(true);
                scrollToBottom("smooth");
              }}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        )}
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
  );
}
