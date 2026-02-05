import { useCallback, useMemo, useState } from "react";
import type { ReactFlowInstance } from "reactflow";
import { trpc } from "../../lib/trpc";
import type {
  FlowEdge,
  FlowNode,
  InsightNode as InsightNodeType,
  InsightNodeData,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../../types/flow";
import type { ProviderProfile } from "../../lib/settings";
import type { ChatMessage } from "../../types/chat";
import { placeInsightNodes } from "../../lib/flowPlacement";
import { INSIGHT_NODE_WIDTH } from "../../lib/elkLayout";
import { useChat } from "@/lib/chat/use-electron-chat";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import { useContextBuilder } from "./useContextBuilder";

interface UseChatActionsOptions {
  projectPath: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  initialMessages: ChatMessage[];
}

interface GraphSnapshot {
  nodes: {
    intId: number;
    type: string;
    label?: string;
    excerpt?: string;
  }[];
  edges: { sourceIntId: number; targetIntId: number }[];
  intIdToNodeId: Map<number, string>;
}

const isStartNode = (node: FlowNode | null) => {
  if (!node || node.type !== "insight") {
    return false;
  }
  const data = node.data as InsightNodeData;
  return data.responseId === "" && data.titleShort === "Start";
};

const buildNodeContext = (node: FlowNode | null) => {
  if (!node) {
    return "";
  }
  if (isStartNode(node)) {
    return "";
  }
  if (node.type === "insight") {
    const data = node.data as InsightNodeData;
    return `Selected node:\nTitle: ${data.titleLong}\nExcerpt: ${data.excerpt}`;
  }
  if (node.type === "source") {
    const data = node.data as SourceNodeType["data"];
    return `Selected source:\nTitle: ${data.title}\nURL: ${data.url}\nSnippet: ${data.snippet ?? ""}`;
  }
  if (node.type === "question") {
    const data = node.data as QuestionNodeType["data"];
    return `Selected Q/A:\nQ: ${data.question}\nA: ${data.answer}`;
  }
  return "";
};

const buildGraphSnapshot = (nodes: FlowNode[], edges: FlowEdge[]): GraphSnapshot => {
  const intIdToNodeId = new Map<number, string>();
  const nodeIdToIntId = new Map<string, number>();
  const graphNodes = nodes.map((node, index) => {
    const intId = index + 1;
    intIdToNodeId.set(intId, node.id);
    nodeIdToIntId.set(node.id, intId);
    const nodeType = node.type ?? "unknown";
    if (node.type === "question") {
      const data = node.data as QuestionNodeType["data"];
      return { intId, type: nodeType, label: data.question, excerpt: data.answer };
    }
    if (node.type === "source") {
      const data = node.data as SourceNodeType["data"];
      return { intId, type: nodeType, label: data.title, excerpt: data.snippet };
    }
    if (node.type === "insight") {
      const data = node.data as InsightNodeData;
      return { intId, type: nodeType, label: data.titleLong, excerpt: data.excerpt };
    }
    return { intId, type: nodeType };
  });

  const graphEdges = edges
    .map((edge) => {
      const sourceIntId = nodeIdToIntId.get(edge.source);
      const targetIntId = nodeIdToIntId.get(edge.target);
      if (!sourceIntId || !targetIntId) {
        return null;
      }
      return { sourceIntId, targetIntId };
    })
    .filter((edge): edge is { sourceIntId: number; targetIntId: number } => edge !== null);

  return { nodes: graphNodes, edges: graphEdges, intIdToNodeId };
};

const hasNodeQuote = (text: string) =>
  /\[\[node:[^\]]+\]\]|\(node:[^)]+\)|node:\/\/[^\s)]+|deertube:\/\/node\/[^\s)]+/i.test(
    text,
  );

const resolveNodeLabel = (node: FlowNode | null) => {
  if (!node) {
    return "Node";
  }
  if (node.type === "question") {
    const data = node.data as QuestionNodeType["data"];
    return data.question || "Question";
  }
  if (node.type === "source") {
    const data = node.data as SourceNodeType["data"];
    return data.title || data.url || "Source";
  }
  if (node.type === "insight") {
    const data = node.data as InsightNodeData;
    return data.titleShort || data.titleLong || data.titleTiny || "Insight";
  }
  return "Node";
};

const buildNodeQuote = (node: FlowNode | null) => {
  if (!node) {
    return "";
  }
  const rawLabel = resolveNodeLabel(node);
  const label = rawLabel.length > 64 ? `${rawLabel.slice(0, 64)}…` : rawLabel;
  return `[[node:${node.id}|${label}]]`;
};

export function useChatActions({
  projectPath,
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedId,
  flowInstance,
  activeProfile,
  initialMessages,
}: UseChatActionsOptions) {
  const [historyInput, setHistoryInput] = useState("");
  const [panelInput, setPanelInput] = useState("");
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphEventMessages, setGraphEventMessages] = useState<ChatMessage[]>(
    () => initialMessages.filter((message) => message.kind === "graph-event"),
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const selectedNodeForContext = useMemo(
    () => (isStartNode(selectedNode) ? null : selectedNode),
    [selectedNode],
  );
  const selectedNodeSummary = useMemo(
    () => buildNodeContext(selectedNodeForContext) || undefined,
    [selectedNodeForContext],
  );
  const { buildContextSummary } = useContextBuilder(nodes, edges);
  const selectedPathSummary = useMemo(
    () => {
      if (!selectedId) {
        return undefined;
      }
      const summary = buildContextSummary(selectedId).trim();
      return summary.length > 0 ? summary : undefined;
    },
    [buildContextSummary, selectedId],
  );
  const selectedNodeForQuote = useMemo(
    () => (selectedId ? nodes.find((node) => node.id === selectedId) ?? null : null),
    [nodes, selectedId],
  );

  const initialUiMessages = useMemo(
    () =>
      initialMessages
        .filter((message) => message.kind !== "graph-event")
        .map(mapChatToUiMessage),
    [initialMessages],
  );

  const runGraphTools = useCallback(
    async (responseId: string, responseText: string) => {
      if (!responseText.trim()) {
        return;
      }
      const eventId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      setGraphEventMessages((prev) => [
        ...prev,
        {
          id: eventId,
          role: "assistant",
          content: "",
          createdAt: startedAt,
          kind: "graph-event",
          toolName: "graph.run",
          toolStatus: "running",
          toolInput: {
            responseId,
            selectedNodeId: selectedId ?? null,
            selectedNodeSummary: selectedNodeSummary ?? null,
          },
        },
      ]);
      setGraphBusy(true);
      try {
        const graphSnapshot = buildGraphSnapshot(nodes, edges);
        const result = await trpc.graph.run.mutate({
          projectPath,
          responseId,
          responseText,
          selectedNodeId: selectedId ?? undefined,
          selectedNodeSummary,
          graph: {
            nodes: graphSnapshot.nodes,
            edges: graphSnapshot.edges,
          },
          settings: activeProfile
            ? {
                llmProvider: activeProfile.llmProvider.trim() || undefined,
                llmModelId: activeProfile.llmModelId.trim() || undefined,
                llmApiKey: activeProfile.llmApiKey.trim() || undefined,
                llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
              }
            : undefined,
        });

        const nodesAdded = result.nodes.length;
        setGraphEventMessages((prev) =>
          prev.map((event) =>
            event.id === eventId
              ? {
                  ...event,
                  toolStatus: "complete",
                  toolOutput: {
                    nodesAdded,
                    nodes: result.nodes,
                  },
                }
              : event,
          ),
        );

        if (!nodesAdded) {
          return;
        }

        const intIdToNodeId = graphSnapshot.intIdToNodeId;
        const workingNodes: FlowNode[] = [...nodes];
        const workingEdges: FlowEdge[] = [...edges];
        const positionMap = new Map<string, { x: number; y: number }>();
        const nodesByParent = new Map<number, { id: string }[]>();

        result.nodes.forEach((node) => {
          const list = nodesByParent.get(node.parentIntId) ?? [];
          list.push({ id: node.id });
          nodesByParent.set(node.parentIntId, list);
        });

        for (const [parentIntId, insightIds] of nodesByParent.entries()) {
          const parentNodeId = intIdToNodeId.get(parentIntId);
          const parentNode = parentNodeId
            ? (workingNodes.find((node) => node.id === parentNodeId) ?? null)
            : null;
          const parentPosition = parentNode?.position ?? { x: 0, y: 0 };
          const positions = await placeInsightNodes({
            parentNode,
            parentPosition,
            nodes: workingNodes,
            edges: workingEdges,
            insights: insightIds,
          });

          insightIds.forEach((insight, index) => {
            const position = positions[index] ?? parentPosition;
            positionMap.set(insight.id, position);
            workingNodes.push({
              id: insight.id,
              type: "insight",
              position,
              data: {
                titleLong: "",
                titleShort: "",
                titleTiny: "",
                excerpt: "",
                responseId: "",
              },
              width: INSIGHT_NODE_WIDTH,
            });
            if (parentNodeId) {
              workingEdges.push({
                id: crypto.randomUUID(),
                source: parentNodeId,
                target: insight.id,
                type: "smoothstep",
              });
            }
          });
        }

        const insightNodes: InsightNodeType[] = result.nodes.map((node) => ({
          id: node.id,
          type: "insight",
          position: positionMap.get(node.id) ?? { x: 0, y: 0 },
          data: {
            titleLong: node.titleLong,
            titleShort: node.titleShort,
            titleTiny: node.titleTiny,
            excerpt: node.excerpt,
            responseId: node.responseId,
          },
          width: INSIGHT_NODE_WIDTH,
        }));

        setNodes((prev: FlowNode[]) => [...prev, ...insightNodes]);
        const newEdges = result.nodes
          .map((node, index) => {
            const parentNodeId = graphSnapshot.intIdToNodeId.get(node.parentIntId);
            if (!parentNodeId) {
              return null;
            }
            return {
              id: crypto.randomUUID(),
              source: parentNodeId,
              target: insightNodes[index]?.id ?? node.id,
              type: "smoothstep",
            };
          })
          .filter((edge) => edge !== null) as FlowEdge[];

        if (newEdges.length > 0) {
          setEdges((prev: FlowEdge[]) => [...prev, ...newEdges]);
        }

        if (flowInstance && insightNodes.length > 0) {
          const focus = insightNodes[0];
          const centerX = focus.position.x + INSIGHT_NODE_WIDTH / 2;
          const centerY = focus.position.y + 120;
          requestAnimationFrame(() => {
            flowInstance.setCenter(centerX, centerY, {
              zoom: flowInstance.getZoom(),
              duration: 400,
            });
          });
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Graph tool failed";
        setGraphEventMessages((prev) =>
          prev.map((event) =>
            event.id === eventId
              ? {
                  ...event,
                  toolStatus: "failed",
                  error: errorMessage,
                }
              : event,
          ),
        );
      } finally {
        setGraphBusy(false);
      }
    },
    [
      activeProfile,
      edges,
      flowInstance,
      nodes,
      projectPath,
      selectedId,
      selectedNodeSummary,
      setEdges,
      setNodes,
    ],
  );

  const { messages, sendMessage, regenerate, status, error, stop } =
    useChat<DeertubeUIMessage>({
    messages: initialUiMessages,
    context: {
      projectPath,
      selectedNodeSummary,
      selectedPathSummary,
      settings: activeProfile
        ? {
            llmProvider: activeProfile.llmProvider.trim() || undefined,
            llmModelId: activeProfile.llmModelId.trim() || undefined,
            llmApiKey: activeProfile.llmApiKey.trim() || undefined,
            llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
          }
        : undefined,
    },
    onFinish: ({ message }: { message?: DeertubeUIMessage }) => {
      if (!message || message.role !== "assistant") {
        return;
      }
      const text = extractUiMessageText(message);
      if (!text.trim()) {
        return;
      }
      void runGraphTools(message.id, text);
    },
  });

  const derivedMessages = useMemo(() => {
    const mapped = mapUiMessagesToChat(messages, status, error);
    if (!graphEventMessages.length) {
      return mapped;
    }
    return mergeGraphEvents(mapped, graphEventMessages);
  }, [messages, status, error, graphEventMessages]);

  const sendPrompt = useCallback(
    (rawPrompt: string, reset: () => void) => {
      if (!rawPrompt.trim()) {
        return;
      }
      const prompt = rawPrompt.trim();
      const quotePrefix =
        selectedNodeForQuote && !hasNodeQuote(prompt)
          ? `${buildNodeQuote(selectedNodeForQuote)} `
          : "";
      const finalPrompt = `${quotePrefix}${prompt}`;
      if (process.env.NODE_ENV !== "production") {
        console.log("[useChatActions] sendPrompt", {
          prompt,
          finalPrompt,
          selectedId,
          selectedNodeForQuote: selectedNodeForQuote?.id ?? null,
        });
      }
      reset();
      if (status === "streaming" || status === "submitted") {
        void stop();
      }
      void sendMessage({ text: finalPrompt });
    },
    [selectedId, selectedNodeForQuote, sendMessage, status, stop],
  );

  const retryMessage = useCallback(
    (_messageId: string) => {
      void regenerate();
    },
    [regenerate],
  );

  const handleSendFromHistory = useCallback(() => {
    void sendPrompt(historyInput, () => setHistoryInput(""));
  }, [historyInput, sendPrompt]);

  const handleSendFromPanel = useCallback(() => {
    void sendPrompt(panelInput, () => setPanelInput(""));
  }, [panelInput, sendPrompt]);

  const busy = status === "streaming" || status === "submitted";

  return {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    busy,
    chatBusy: busy,
    graphBusy,
    handleSendFromHistory,
    handleSendFromPanel,
    retryMessage,
    selectedNode,
    messages: derivedMessages,
  };
}

function mapChatToUiMessage(message: ChatMessage): DeertubeUIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.content
      ? [
          {
            type: "text",
            text: message.content,
          },
        ]
      : [],
  };
}

function extractUiMessageText(message: DeertubeUIMessage): string {
  if ("content" in message && typeof message.content === "string") {
    return message.content;
  }
  if (!("parts" in message) || !Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part,
    )
    .map((part) => part.text)
    .join("");
}

function mapUiMessagesToChat(
  messages: DeertubeUIMessage[],
  status: string,
  error: Error | undefined,
): ChatMessage[] {
  const mapped: ChatMessage[] = messages.map((message) => {
    const content = extractUiMessageText(message);
    const createdAt =
      "createdAt" in message && message.createdAt
        ? message.createdAt instanceof Date
          ? message.createdAt.toISOString()
          : String(message.createdAt)
        : new Date().toISOString();
    return {
      id: message.id,
      role: message.role as ChatMessage["role"],
      content,
      createdAt,
    };
  });

  const lastAssistantIndex = [...mapped]
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "assistant")
    .slice(-1)[0]?.index;

  if (lastAssistantIndex !== undefined) {
    const lastAssistant = mapped[lastAssistantIndex];
    if (status === "streaming" || status === "submitted") {
      lastAssistant.status = "pending";
    } else if (status === "error") {
      lastAssistant.status = "failed";
      lastAssistant.error = error?.message ?? "Request failed";
    } else {
      lastAssistant.status = "complete";
    }
  }

  return mapped;
}

function mergeGraphEvents(
  messages: ChatMessage[],
  graphEvents: ChatMessage[],
): ChatMessage[] {
  if (graphEvents.length === 0) {
    return messages;
  }
  const byResponseId = new Map<string, ChatMessage[]>();
  const unattached: ChatMessage[] = [];

  graphEvents.forEach((event) => {
    const responseId = getGraphEventResponseId(event);
    if (!responseId) {
      unattached.push(event);
      return;
    }
    const list = byResponseId.get(responseId) ?? [];
    list.push(event);
    byResponseId.set(responseId, list);
  });

  const merged: ChatMessage[] = [];
  messages.forEach((message) => {
    merged.push(message);
    const events = byResponseId.get(message.id);
    if (events && events.length > 0) {
      merged.push(...events);
      byResponseId.delete(message.id);
    }
  });

  if (byResponseId.size > 0) {
    byResponseId.forEach((events) => merged.push(...events));
  }
  if (unattached.length > 0) {
    merged.push(...unattached);
  }

  return merged;
}

function getGraphEventResponseId(event: ChatMessage): string | null {
  if (event.kind !== "graph-event") {
    return null;
  }
  if (!event.toolInput || typeof event.toolInput !== "object") {
    return null;
  }
  if (!("responseId" in event.toolInput)) {
    return null;
  }
  const responseId = (event.toolInput as { responseId?: unknown }).responseId;
  return typeof responseId === "string" ? responseId : null;
}
