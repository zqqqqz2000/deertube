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

  const initialUiMessages = useMemo(
    () => initialMessages.map(mapChatToUiMessage),
    [initialMessages],
  );

  const runGraphTools = useCallback(
    async (responseId: string, responseText: string) => {
      if (!responseText.trim()) {
        return;
      }
      setGraphBusy(true);
      try {
        const result = await trpc.graph.run.mutate({
          projectPath,
          responseId,
          responseText,
          selectedNodeId: selectedId ?? undefined,
          selectedNodeSummary,
          settings: activeProfile
            ? {
                llmProvider: activeProfile.llmProvider.trim() || undefined,
                llmModelId: activeProfile.llmModelId.trim() || undefined,
                llmApiKey: activeProfile.llmApiKey.trim() || undefined,
                llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
              }
            : undefined,
        });

        if (!result.nodes.length) {
          return;
        }

        const parentNode = selectedNode ?? null;
        const parentPosition = parentNode?.position ?? { x: 0, y: 0 };
        const insightIds = result.nodes.map((node) => ({ id: node.id }));
        const positions = await placeInsightNodes({
          parentNode,
          parentPosition,
          nodes,
          edges,
          insights: insightIds,
        });

        const insightNodes: InsightNodeType[] = result.nodes.map((node, index) => ({
          id: node.id,
          type: "insight",
          position: positions[index],
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
        if (selectedId) {
          const newEdges: FlowEdge[] = insightNodes.map((node) => ({
            id: crypto.randomUUID(),
            source: selectedId,
            target: node.id,
            type: "smoothstep",
          }));
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
      selectedNode,
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

  const derivedMessages = useMemo(
    () => mapUiMessagesToChat(messages, status, error),
    [messages, status, error],
  );

  const sendPrompt = useCallback(
    (rawPrompt: string, reset: () => void) => {
      if (!rawPrompt.trim()) {
        return;
      }
      const prompt = rawPrompt.trim();
      reset();
      if (status === "streaming" || status === "submitted") {
        void stop();
      }
      void sendMessage({ text: prompt });
    },
    [sendMessage, status, stop],
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
