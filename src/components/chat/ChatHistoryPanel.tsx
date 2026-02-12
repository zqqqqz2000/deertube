import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import { isJsonObject } from "@/types/json";
import type {
  ChatMessage,
  DeepSearchStreamPayload,
  GraphToolInput,
  GraphToolOutput,
  SubagentStreamPayload,
} from "../../types/chat";
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
  MarkdownRenderer,
  type MarkdownReferencePreview,
} from "@/components/markdown/renderer";
import {
  ChatEvent,
  ChatEventAddon,
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
  ChatToolbarAddonStart,
  ChatToolbarAddonEnd,
  ChatToolbarTextarea,
} from "@/modules/chat/components/chat-toolbar";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Globe,
  Loader2,
  MessageSquare,
  Network,
  RotateCw,
  Send,
} from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { BrowserViewSelection } from "@/types/browserview";

interface ChatHistoryPanelProps {
  developerMode?: boolean;
  messages: ChatMessage[];
  selectedResponseId: string | null;
  selectedNode?: FlowNode | null;
  nodes?: FlowNode[];
  onFocusNode?: (nodeId: string) => void;
  onReferenceClick?: (url: string, label?: string) => void;
  onResolveReferencePreview?: (
    uri: string,
  ) => Promise<MarkdownReferencePreview | null>;
  browserSelection?: BrowserViewSelection | null;
  onInsertBrowserSelection?: (selection: BrowserViewSelection) => void;
  scrollToBottomSignal?: number;
  focusSignal?: number;
  onRequestClearSelection?: () => void;
  input: string;
  busy: boolean;
  graphBusy?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onRetry?: (messageId: string) => void;
  lastFailedMessageId?: string | null;
}

interface SubagentEntry {
  kind: "call" | "result";
  label: string;
  compactDetail?: string;
  fullDetail?: string;
  tone?: "warn";
}

const TOOL_DETAIL_MAX_CHARS = 120;

const truncateInline = (value: string, maxChars = TOOL_DETAIL_MAX_CHARS): string => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 3))}...`;
};

const parseToolPayload = (value: unknown): unknown => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value ?? null;
};

const stripLineNumberPrefix = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isJsonObject(value);

const isSubagentPayload = (value: unknown): value is SubagentStreamPayload => {
  if (!value || !isRecord(value)) {
    return false;
  }
  return typeof value.toolCallId === "string" && Array.isArray(value.messages);
};

const isDeepSearchPayload = (value: unknown): value is DeepSearchStreamPayload => {
  if (!value || !isRecord(value)) {
    return false;
  }
  return "sources" in value || "conclusion" in value || "query" in value || "status" in value;
};

type DeertubeMessagePart = DeertubeUIMessage["parts"][number];
type ToolMessagePart = Extract<
  DeertubeMessagePart,
  { type: `tool-${string}` | "dynamic-tool" }
>;

const isToolPart = (
  part: DeertubeMessagePart,
): part is ToolMessagePart => part.type.startsWith("tool-") || part.type === "dynamic-tool";

const getToolName = (part: ToolMessagePart): string | undefined => {
  if (part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }
  return undefined;
};

const summarizeToolInput = (toolName: string | undefined, input: unknown) => {
  if (!isRecord(input)) {
    return undefined;
  }
  if (toolName === "search" && typeof input.query === "string") {
    return `query: ${input.query}`;
  }
  if (toolName === "extract" && typeof input.url === "string") {
    return `url: ${input.url}`;
  }
  const preview = JSON.stringify(input);
  return preview.length > 160 ? `${preview.slice(0, 160)}...` : preview;
};

const summarizeToolOutput = (
  toolName: string | undefined,
  output: unknown,
): { detail?: string; tone?: "warn" } => {
  if (!isRecord(output)) {
    return { detail: undefined };
  }
  if (toolName === "search" && Array.isArray(output.results)) {
    return { detail: `results: ${output.results.length}` };
  }
  if (toolName === "extract") {
    const selections = Array.isArray(output.selections)
      ? output.selections.length
      : undefined;
    const broken = output.broken === true;
    const detailParts: string[] = [];
    if (typeof selections === "number") detailParts.push(`selections: ${selections}`);
    if (broken) detailParts.push("broken");
    return {
      detail: detailParts.length > 0 ? detailParts.join(", ") : undefined,
      tone: broken ? "warn" : undefined,
    };
  }
  return { detail: undefined };
};

const stringifyToolDetail = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = parseToolPayload(trimmed);
    if (parsed !== null && typeof parsed !== "string") {
      const serialized = JSON.stringify(parsed, null, 2);
      return serialized ?? trimmed;
    }
    return trimmed;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
};

const buildSubagentEntries = (payload: SubagentStreamPayload): SubagentEntry[] => {
  const entries: SubagentEntry[] = [];
  payload.messages.forEach((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("parts" in message) ||
      !Array.isArray((message as { parts?: unknown }).parts)
    ) {
      return;
    }
    const parts = (message as { parts: DeertubeMessagePart[] }).parts;
    parts.forEach((part) => {
      if (!isToolPart(part)) {
        return;
      }
      const toolName = getToolName(part);
      if ("input" in part && part.input !== undefined) {
        entries.push({
          kind: "call",
          label: toolName ?? "tool",
          compactDetail: summarizeToolInput(toolName, part.input),
          fullDetail: stringifyToolDetail(part.input),
        });
      }
      if ("output" in part && part.output !== undefined) {
        const summary = summarizeToolOutput(toolName, part.output);
        entries.push({
          kind: "result",
          label: toolName ?? "tool",
          compactDetail: summary.detail,
          fullDetail: stringifyToolDetail(part.output),
          tone: summary.tone,
        });
      }
    });
  });
  return entries;
};

const parseGraphToolInput = (value: ChatMessage["toolInput"]): GraphToolInput | null => {
  if (!value || !isRecord(value)) {
    return null;
  }
  const responseId =
    typeof value.responseId === "string" && value.responseId.length > 0
      ? value.responseId
      : undefined;
  const selectedNodeId =
    typeof value.selectedNodeId === "string" || value.selectedNodeId === null
      ? value.selectedNodeId
      : undefined;
  const selectedNodeSummary =
    typeof value.selectedNodeSummary === "string" ||
    value.selectedNodeSummary === null
      ? value.selectedNodeSummary
      : undefined;
  if (
    !responseId &&
    selectedNodeId === undefined &&
    selectedNodeSummary === undefined
  ) {
    return null;
  }
  return { responseId, selectedNodeId, selectedNodeSummary };
};

const readToolCallId = (value: ChatMessage["toolInput"]): string | null => {
  if (!value || !isRecord(value)) {
    return null;
  }
  return typeof value.toolCallId === "string" ? value.toolCallId : null;
};

export default function ChatHistoryPanel({
  developerMode = false,
  messages,
  selectedResponseId,
  selectedNode,
  nodes = [],
  onFocusNode,
  onReferenceClick,
  onResolveReferencePreview,
  browserSelection,
  onInsertBrowserSelection,
  scrollToBottomSignal = 0,
  focusSignal = 0,
  onRequestClearSelection,
  input,
  busy,
  graphBusy = false,
  onInputChange,
  onSend,
  onRetry,
  lastFailedMessageId: lastFailedMessageIdProp,
}: ChatHistoryPanelProps) {
  const { scrollRef, contentRef } = useStickToBottom();
  const highlightedId = selectedResponseId;
  const ignoreHighlightRef = useRef(false);
  const [subagentOpenById, setSubagentOpenById] = useState<Record<string, boolean>>({});
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
  const selectedTagLabel = useMemo(() => {
    if (!selectedSummary) {
      return "";
    }
    const title =
      typeof selectedSummary.title === "string" && selectedSummary.title.trim().length > 0
        ? selectedSummary.title.trim()
        : selectedSummary.kind;
    return title ? `@${title}` : "";
  }, [selectedSummary]);
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
  useEffect(() => {
    setSubagentOpenById((previous) => {
      const next = { ...previous };
      const activeIds = new Set<string>();
      let changed = false;
      messages.forEach((message) => {
        if (message.kind !== "subagent-event") {
          return;
        }
        activeIds.add(message.id);
        const prior = next[message.id];
        if (prior === undefined) {
          next[message.id] = message.toolStatus === "running";
          changed = true;
          return;
        }
        if (message.toolStatus === "running" && prior !== true) {
          next[message.id] = true;
          changed = true;
        }
      });
      Object.keys(next).forEach((id) => {
        if (activeIds.has(id)) {
          return;
        }
        delete next[id];
        changed = true;
      });
      if (!changed) {
        return previous;
      }
      return next;
    });
  }, [messages]);
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

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!scrollRef.current) {
        return;
      }
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior,
      });
    },
    [scrollRef],
  );

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) {
      return;
    }
    const el = scrollRef.current;
    const threshold = 24;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
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
      | {
          kind: "subagent";
          id: string;
          message: ChatMessage;
          deepSearchMessage?: ChatMessage;
        }
      | { kind: "deepsearch"; id: string; message: ChatMessage }
    )[] = [];
    const deepSearchByToolCall = new Map<string, ChatMessage>();
    const subagentToolCallIds = new Set<string>();
    let lastDateKey = "";
    let lastRole: ChatMessage["role"] | null = null;

    sortedMessages.forEach((message) => {
      if (message.kind === "subagent-event") {
        const toolCallId = readToolCallId(message.toolInput);
        if (toolCallId) {
          subagentToolCallIds.add(toolCallId);
        }
      }
      if (message.kind !== "deepsearch-event") {
        return;
      }
      const toolCallId = readToolCallId(message.toolInput);
      if (!toolCallId) {
        return;
      }
      deepSearchByToolCall.set(toolCallId, message);
    });

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
      if (message.kind === "subagent-event") {
        const toolCallId = readToolCallId(message.toolInput);
        const deepSearchMessage = toolCallId
          ? deepSearchByToolCall.get(toolCallId)
          : undefined;
        items.push({
          kind: "subagent",
          id: message.id,
          message,
          deepSearchMessage,
        });
        lastRole = null;
        return;
      }
      if (message.kind === "deepsearch-event") {
        const toolCallId = readToolCallId(message.toolInput);
        if (toolCallId && subagentToolCallIds.has(toolCallId)) {
          // Prefer rendering deep-search updates inside the matching subagent card.
          lastRole = null;
          return;
        }
        items.push({ kind: "deepsearch", id: message.id, message });
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
  const hasBrowserSelection = Boolean(
    browserSelection && browserSelection.text.trim().length > 0,
  );
  const browserSelectionLabel = useMemo(() => {
    if (!browserSelection) {
      return "";
    }
    const text = browserSelection.text.trim().replace(/\s+/g, " ");
    if (!text) {
      return "";
    }
    return text.length > 80 ? `${text.slice(0, 80)}...` : text;
  }, [browserSelection]);
  const lastFailedMessageId = useMemo(() => {
    if (lastFailedMessageIdProp !== undefined) {
      return lastFailedMessageIdProp;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.kind === "graph-event" ||
        message.kind === "subagent-event" ||
        message.kind === "deepsearch-event"
      ) {
        continue;
      }
      return message.status === "failed" ? message.id : null;
    }
    return null;
  }, [lastFailedMessageIdProp, messages]);
  const showRetry = Boolean(lastFailedMessageId && onRetry);
  const handlePrimaryAction = useCallback(() => {
    if (showRetry && lastFailedMessageId && onRetry) {
      onRetry(lastFailedMessageId);
      return;
    }
    onSend();
  }, [lastFailedMessageId, onRetry, onSend, showRetry]);

  const getToolStatusLabel = useCallback((status: ChatMessage["toolStatus"]) => {
    if (status === "running") {
      return "Running";
    }
    if (status === "failed") {
      return "Failed";
    }
    return "Complete";
  }, []);

  const getToolCardClassName = useCallback((status: ChatMessage["toolStatus"]) => {
    if (status === "running") {
      return "message-marquee border-sky-400/50 bg-sky-500/5";
    }
    if (status === "failed") {
      return "border-destructive/40 bg-destructive/10";
    }
    return "border-border/60 bg-card/25";
  }, []);

  const renderCompleteIcon = useCallback(
    (status: ChatMessage["toolStatus"]) =>
      status === "complete" ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Complete" />
      ) : null,
    [],
  );

  const renderEventLogo = useCallback(
    (kind: "graph" | "subagent" | "deepsearch") => {
      if (kind === "graph") {
        return (
          <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
            <Network className="size-4 @md/chat:size-5" />
          </div>
        );
      }
      if (kind === "subagent") {
        return (
          <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
            <MessageSquare className="size-4 @md/chat:size-5" />
          </div>
        );
      }
      return (
        <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
          <Globe className="size-4 @md/chat:size-5" />
        </div>
      );
    },
    [],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden border border-border/70 bg-background/85 shadow-2xl shadow-black/25 backdrop-blur">
      <Chat>
        <ChatMessages
          ref={scrollRef}
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
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);

                const isGraphOutputPayload = (
                  value: unknown,
                ): value is GraphToolOutput => {
                  if (!value || !isRecord(value)) {
                    return false;
                  }
                  if ("nodes" in value && Array.isArray(value.nodes)) {
                    return true;
                  }
                  if ("nodesAdded" in value && typeof value.nodesAdded === "number") {
                    return true;
                  }
                  if ("explanation" in value && typeof value.explanation === "string") {
                    return true;
                  }
                  return false;
                };

                const outputPayloadRaw = parseToolPayload(
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
                const graphToolInput = parseGraphToolInput(
                  eventMessage.toolInput,
                );
                const responseId = graphToolInput?.responseId;
                const selectedNodeId =
                  graphToolInput?.selectedNodeId ?? undefined;
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

                const compactCallParts: string[] = [];
                if (responseId) {
                  compactCallParts.push(`response: ${responseId.slice(0, 8)}`);
                }
                if (selectedLabel) {
                  compactCallParts.push(`selected: ${selectedLabel}`);
                }
                const compactCall = truncateInline(compactCallParts.join(" | "));
                const callDetail = stringifyToolDetail(eventMessage.toolInput);
                const resultDetail = stringifyToolDetail(eventMessage.toolOutput);
                const hasDetails =
                  logLines.length > 0 ||
                  nodesAdded !== undefined ||
                  nodesFromOutput.length > 0 ||
                  !!explanation ||
                  Boolean(callDetail) ||
                  Boolean(resultDetail);

                return (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("graph")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      {developerMode ? (
                        <Collapsible defaultOpen={eventMessage.toolStatus === "running"}>
                          <div className="flex items-center justify-between gap-2">
                            <ChatEventTitle className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                              Graph Update
                            </ChatEventTitle>
                            <div className="flex items-center gap-1">
                              {renderCompleteIcon(eventMessage.toolStatus)}
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
                          </div>
                          <ChatEventDescription>{statusLabel}</ChatEventDescription>
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
                                {callDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Call
                                    </div>
                                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {callDetail}
                                    </pre>
                                  </div>
                                )}
                                {resultDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Result
                                    </div>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {resultDetail}
                                    </pre>
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
                                        typeof node.id === "string"
                                          ? node.id
                                          : "";
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
                      ) : (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <ChatEventTitle className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                              Graph Update
                            </ChatEventTitle>
                            {renderCompleteIcon(eventMessage.toolStatus)}
                          </div>
                          <ChatEventDescription>{statusLabel}</ChatEventDescription>
                          {compactCall && (
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {compactCall}
                            </div>
                          )}
                        </>
                      )}
                    </ChatEventBody>
                  </ChatEvent>
                );
              }
              if (item.kind === "subagent") {
                const { message: eventMessage } = item;
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);
                const deepSearchMessage = item.deepSearchMessage;

                const outputPayloadRaw = parseToolPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isSubagentPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const entries = outputPayload
                  ? buildSubagentEntries(outputPayload)
                  : [];
                const deepSearchOutputPayloadRaw = parseToolPayload(
                  deepSearchMessage?.toolOutput,
                );
                const deepSearchOutputPayload = isDeepSearchPayload(
                  deepSearchOutputPayloadRaw,
                )
                  ? deepSearchOutputPayloadRaw
                  : null;
                const deepSearchStatus = deepSearchMessage?.toolStatus;
                const deepSearchStatusLabel = deepSearchMessage?.error
                  ? deepSearchMessage.error
                  : getToolStatusLabel(deepSearchStatus);
                const deepSearchTitle =
                  deepSearchMessage?.toolName ??
                  deepSearchOutputPayload?.toolName ??
                  "Search";
                const deepSearchSources = Array.isArray(
                  deepSearchOutputPayload?.sources,
                )
                  ? deepSearchOutputPayload.sources
                  : [];
                const deepSearchQuery =
                  typeof deepSearchOutputPayload?.query === "string"
                    ? deepSearchOutputPayload.query
                    : undefined;
                const deepSearchError =
                  typeof deepSearchOutputPayload?.error === "string"
                    ? deepSearchOutputPayload.error
                    : undefined;
                const deepSearchCallDetail = stringifyToolDetail(
                  deepSearchMessage?.toolInput,
                );
                const deepSearchResultDetail = stringifyToolDetail(
                  deepSearchMessage?.toolOutput,
                );
                const deepSearchCompactParts: string[] = [];
                if (deepSearchQuery) {
                  deepSearchCompactParts.push(`query: ${deepSearchQuery}`);
                }
                if (deepSearchSources.length > 0) {
                  deepSearchCompactParts.push(
                    `sources: ${deepSearchSources.length}`,
                  );
                }
                if (deepSearchError) {
                  deepSearchCompactParts.push(
                    `error: ${truncateInline(deepSearchError, 80)}`,
                  );
                }
                const deepSearchCompactSummary = truncateInline(
                  deepSearchCompactParts.join(" | "),
                );
                const hasDeepSearchDetails = Boolean(deepSearchMessage);
                const title = eventMessage.toolName ?? outputPayload?.toolName ?? "Subagent";
                const compactCallEntries = entries
                  .filter((entry) => entry.kind === "call")
                  .map((entry) => {
                    const detailSource = entry.compactDetail ?? entry.fullDetail;
                    const merged = detailSource
                      ? `${entry.label}: ${detailSource}`
                      : entry.label;
                    return truncateInline(merged);
                  });
                const hasDetails = developerMode
                  ? entries.length > 0 || hasDeepSearchDetails
                  : compactCallEntries.length > 0 || Boolean(deepSearchCompactSummary);
                const subagentOpen =
                  subagentOpenById[item.id] ?? eventMessage.toolStatus === "running";

                return (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("subagent")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      <Collapsible
                        open={subagentOpen}
                        onOpenChange={(nextOpen) => {
                          setSubagentOpenById((previous) => ({
                            ...previous,
                            [item.id]: nextOpen,
                          }));
                        }}
                        className="min-w-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            {title}
                          </ChatEventTitle>
                          <div className="flex items-center gap-1">
                            {renderCompleteIcon(eventMessage.toolStatus)}
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
                        </div>
                        <ChatEventDescription>{statusLabel}</ChatEventDescription>
                        {hasDetails && (
                          <CollapsibleContent className="mt-2">
                            <ChatEventContent className="space-y-2">
                              {developerMode ? (
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  {entries.map((entry, index) => {
                                    const detail = entry.fullDetail ?? entry.compactDetail;
                                    return (
                                      <div
                                        key={`${item.id}-subagent-${index}`}
                                        className={cn(
                                          "flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-card/40 px-2 py-1",
                                          entry.tone === "warn" &&
                                            "border-amber-400/40 bg-amber-500/10 text-amber-700",
                                        )}
                                      >
                                        <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/60">
                                          {entry.kind === "call" ? "Call" : "Result"}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate text-xs font-medium text-foreground/80">
                                            {entry.label}
                                          </div>
                                          {detail && (
                                            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                              {detail}
                                            </pre>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                  {deepSearchMessage && (
                                    <div className="space-y-2 rounded-md border border-border/60 bg-card/40 p-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="truncate text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/80">
                                          {deepSearchTitle}
                                        </div>
                                        {deepSearchStatus && renderCompleteIcon(deepSearchStatus)}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {deepSearchError ? deepSearchError : deepSearchStatusLabel}
                                      </div>
                                      {(((deepSearchQuery ?? "").length > 0) ||
                                        deepSearchSources.length > 0) && (
                                        <div className="space-y-1 text-[11px] text-muted-foreground">
                                          {deepSearchQuery && (
                                            <div className="break-words">{`Query: ${deepSearchQuery}`}</div>
                                          )}
                                          {deepSearchSources.length > 0 && (
                                            <div>{`Sources: ${deepSearchSources.length}`}</div>
                                          )}
                                        </div>
                                      )}
                                      {deepSearchCallDetail && (
                                        <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                          <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                            Call
                                          </div>
                                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                            {deepSearchCallDetail}
                                          </pre>
                                        </div>
                                      )}
                                      {deepSearchResultDetail && (
                                        <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                          <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                            Result
                                          </div>
                                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                            {deepSearchResultDetail}
                                          </pre>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  {compactCallEntries.map((line, index) => (
                                    <div
                                      key={`${item.id}-subagent-call-${index}`}
                                      className="truncate rounded-md border border-border/60 bg-card/40 px-2 py-1"
                                      title={line}
                                    >
                                      {line}
                                    </div>
                                  ))}
                                  {deepSearchCompactSummary && (
                                    <div
                                      className="truncate rounded-md border border-border/60 bg-card/40 px-2 py-1"
                                      title={deepSearchCompactSummary}
                                    >
                                      {`${deepSearchTitle}: ${deepSearchCompactSummary}`}
                                    </div>
                                  )}
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
              if (item.kind === "deepsearch") {
                const { message: eventMessage } = item;
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);

                const outputPayloadRaw = parseToolPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isDeepSearchPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const sources = Array.isArray(outputPayload?.sources)
                  ? outputPayload?.sources ?? []
                  : [];
                const conclusion =
                  typeof outputPayload?.conclusion === "string"
                    ? outputPayload.conclusion
                    : undefined;
                const query =
                  typeof outputPayload?.query === "string"
                    ? outputPayload.query
                    : undefined;
                const error =
                  typeof outputPayload?.error === "string"
                    ? outputPayload.error
                    : undefined;
                const callDetail = stringifyToolDetail(eventMessage.toolInput);
                const resultDetail = stringifyToolDetail(eventMessage.toolOutput);
                const title =
                  eventMessage.toolName ??
                  outputPayload?.toolName ??
                  "DeepSearch";
                const hasDetails =
                  !!query ||
                  sources.length > 0 ||
                  !!conclusion ||
                  Boolean(callDetail) ||
                  Boolean(resultDetail);
                const compactParts: string[] = [];
                if (query) {
                  compactParts.push(`query: ${query}`);
                }
                if (sources.length > 0) {
                  compactParts.push(`sources: ${sources.length}`);
                }
                const compactSummary = truncateInline(compactParts.join(" | "));

                return (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("deepsearch")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      {developerMode ? (
                        <Collapsible defaultOpen={eventMessage.toolStatus === "running"} className="min-w-0">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                              {title}
                            </ChatEventTitle>
                            <div className="flex items-center gap-1">
                              {renderCompleteIcon(eventMessage.toolStatus)}
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
                          </div>
                          <ChatEventDescription>
                            {error ? error : statusLabel}
                          </ChatEventDescription>
                          {hasDetails && (
                            <CollapsibleContent className="mt-2 min-w-0">
                              <ChatEventContent className="min-w-0 space-y-2">
                                <div className="space-y-1 break-words text-[11px] text-muted-foreground">
                                  {query && <div className="break-words">{`Query: ${query}`}</div>}
                                  {sources.length > 0 && (
                                    <div>{`Sources: ${sources.length}`}</div>
                                  )}
                                </div>
                                {callDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Call
                                    </div>
                                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {callDetail}
                                    </pre>
                                  </div>
                                )}
                                {resultDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Result
                                    </div>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {resultDetail}
                                    </pre>
                                  </div>
                                )}
                                {conclusion && (
                                  <div className="break-words rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
                                    {conclusion}
                                  </div>
                                )}
                                {sources.length > 0 && (
                                  <div className="min-w-0 space-y-2">
                                    {sources.map((source, index) => {
                                      const url =
                                        typeof source.url === "string"
                                          ? source.url
                                          : "";
                                      const sourceTitle =
                                        typeof source.title === "string" &&
                                        source.title.trim()
                                          ? source.title
                                          : url || `Source ${index + 1}`;
                                      const snippet =
                                        typeof source.snippet === "string"
                                          ? source.snippet
                                          : "";
                                      const excerptLines = Array.isArray(source.excerpts)
                                        ? source.excerpts
                                            .filter(
                                              (excerpt): excerpt is string =>
                                                typeof excerpt === "string" &&
                                                excerpt.trim().length > 0,
                                            )
                                            .map((excerpt) =>
                                              stripLineNumberPrefix(excerpt),
                                            )
                                        : [];
                                      const hoverText = excerptLines.join("\n\n").trim();
                                      return (
                                        <button
                                          key={`${item.id}-source-${index}`}
                                          type="button"
                                          className="min-w-0 max-w-full w-full overflow-hidden rounded-md border border-border/70 bg-card/60 px-3 py-2 text-left text-xs transition hover:border-border hover:bg-card/80"
                                          title={hoverText || undefined}
                                          onClick={() => {
                                            if (url && onReferenceClick) {
                                              onReferenceClick(url, sourceTitle);
                                            }
                                          }}
                                        >
                                          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                            Source
                                          </div>
                                          <div className="break-words text-sm font-semibold text-foreground">
                                            {sourceTitle}
                                          </div>
                                          {url && (
                                            <div className="mt-1 max-w-full truncate text-[11px] text-muted-foreground">
                                              {url}
                                            </div>
                                          )}
                                          {snippet && (
                                            <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                                              {snippet}
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
                      ) : (
                        <>
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                              {title}
                            </ChatEventTitle>
                            {renderCompleteIcon(eventMessage.toolStatus)}
                          </div>
                          <ChatEventDescription>
                            {error ? error : statusLabel}
                          </ChatEventDescription>
                          {compactSummary && (
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {compactSummary}
                            </div>
                          )}
                        </>
                      )}
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
              const resolvedContent =
                !isUser && isFailed && !displayContent?.trim()
                  ? message.error ?? "Request failed"
                  : displayContent;
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
                  {isUser ? (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {renderUserContent(displayContent ?? "")}
                    </div>
                  ) : (
                    <MarkdownRenderer
                      source={resolvedContent ?? ""}
                      highlightExcerpt={
                        shouldHighlightExcerpt ? selectedExcerpt : undefined
                      }
                      onNodeLinkClick={handleNodeLinkClick}
                      onReferenceClick={onReferenceClick}
                      resolveReferencePreview={onResolveReferencePreview}
                      resolveNodeLabel={resolveNodeLabel}
                      nodeExcerptRefs={nodeExcerptRefs}
                    />
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
          {(selectedTagLabel || hasBrowserSelection) && (
            <ChatToolbarAddonStart>
              {selectedTagLabel && (
                <span
                  className="max-w-[140px] truncate rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-[11px] font-medium text-foreground/80 @md/chat:max-w-[220px]"
                  title={selectedTagLabel}
                >
                  {selectedTagLabel}
                </span>
              )}
              {hasBrowserSelection && (
                <button
                  type="button"
                  className="max-w-[220px] truncate rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-100/90 transition hover:border-sky-300/60 hover:bg-sky-500/20"
                  title={browserSelection?.text}
                  onClick={() => {
                    if (browserSelection && onInsertBrowserSelection) {
                      onInsertBrowserSelection(browserSelection);
                    }
                  }}
                >
                  {browserSelectionLabel || "Use web selection"}
                </button>
              )}
            </ChatToolbarAddonStart>
          )}
          <ChatToolbarTextarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask a question..."
            disabled={busy}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                selectedSummary &&
                onRequestClearSelection
              ) {
                const target = event.currentTarget;
                if (target.selectionStart === 0 && target.selectionEnd === 0) {
                  event.preventDefault();
                  onRequestClearSelection();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handlePrimaryAction();
              }
            }}
          />
          <ChatToolbarAddonEnd>
            <Button
              size="icon"
              variant={showRetry ? "destructive" : "default"}
              className="h-8 w-8 rounded-md"
              onClick={handlePrimaryAction}
              disabled={busy || (!showRetry && !input.trim())}
              aria-label={showRetry ? "Retry request" : "Send message"}
              title={showRetry ? "Retry request" : "Send message"}
            >
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : showRetry ? (
                <RotateCw />
              ) : (
                <Send />
              )}
            </Button>
          </ChatToolbarAddonEnd>
        </ChatToolbar>
      </Chat>
    </div>
  );
}
