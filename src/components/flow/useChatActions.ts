import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
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

interface UseChatActionsOptions {
  projectPath: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

const buildNodeContext = (node: FlowNode | null) => {
  if (!node) {
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
  messages,
  setMessages,
}: UseChatActionsOptions) {
  const [historyInput, setHistoryInput] = useState("");
  const [panelInput, setPanelInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [graphBusy, setGraphBusy] = useState(false);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const buildPrompt = useCallback(
    (prompt: string) => {
      const base = prompt.trim();
      if (!base) {
        return "";
      }
      const context = buildNodeContext(selectedNode);
      return context ? `${base}\n\n${context}` : base;
    },
    [selectedNode],
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
          selectedNodeSummary: buildNodeContext(selectedNode),
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
      setEdges,
      setNodes,
    ],
  );

  const sendPrompt = useCallback(
    async (rawPrompt: string, reset: () => void) => {
      if (chatBusy || !rawPrompt.trim()) {
        return;
      }
      const prompt = buildPrompt(rawPrompt);
      if (!prompt) {
        return;
      }
      reset();

      const now = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt,
        createdAt: now,
      };
      const responseId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: responseId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        status: "pending",
        requestText: prompt,
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setChatBusy(true);

      try {
        const response = await trpc.chat.send.mutate({
          projectPath,
          messages: [...messages, userMessage].map((message) => ({
            role: message.role,
            content: message.content,
          })),
          settings: activeProfile
            ? {
                llmProvider: activeProfile.llmProvider.trim() || undefined,
                llmModelId: activeProfile.llmModelId.trim() || undefined,
                llmApiKey: activeProfile.llmApiKey.trim() || undefined,
                llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
              }
            : undefined,
        });

        setMessages((prev) =>
          prev.map((message) =>
            message.id === responseId
              ? { ...message, content: response.text, status: "complete" }
              : message,
          ),
        );

        void runGraphTools(responseId, response.text);
      } catch {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === responseId
              ? {
                  ...message,
                  content: "Request failed. Please try again.",
                  status: "failed",
                  error: "Request failed",
                }
              : message,
          ),
        );
      } finally {
        setChatBusy(false);
      }
    },
    [activeProfile, buildPrompt, chatBusy, messages, projectPath, runGraphTools, setMessages],
  );

  const retryMessage = useCallback(
    (messageId: string) => {
      const target = messages.find((message) => message.id === messageId);
      if (!target || target.role !== "assistant" || !target.requestText) {
        return;
      }
      const requestText = target.requestText;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? { ...message, content: "", status: "pending", error: undefined }
            : message,
        ),
      );
      void (async () => {
        setChatBusy(true);
        try {
          const response = await trpc.chat.send.mutate({
            projectPath,
            messages: messages
              .filter((message) => message.role !== "assistant" || message.id !== messageId)
              .map((message) => ({
                role: message.role,
                content: message.content,
              }))
              .concat({ role: "user", content: requestText }),
            settings: activeProfile
              ? {
                  llmProvider: activeProfile.llmProvider.trim() || undefined,
                  llmModelId: activeProfile.llmModelId.trim() || undefined,
                  llmApiKey: activeProfile.llmApiKey.trim() || undefined,
                  llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
                }
              : undefined,
          });

          setMessages((prev) =>
            prev.map((message) =>
              message.id === messageId
                ? { ...message, content: response.text, status: "complete" }
                : message,
            ),
          );
          void runGraphTools(messageId, response.text);
        } catch {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    content: "Request failed. Please try again.",
                    status: "failed",
                    error: "Request failed",
                  }
                : message,
            ),
          );
        } finally {
          setChatBusy(false);
        }
      })();
    },
    [activeProfile, messages, projectPath, runGraphTools, setMessages],
  );

  const handleSendFromHistory = useCallback(() => {
    void sendPrompt(historyInput, () => setHistoryInput(""));
  }, [historyInput, sendPrompt]);

  const handleSendFromPanel = useCallback(() => {
    void sendPrompt(panelInput, () => setPanelInput(""));
  }, [panelInput, sendPrompt]);

  const busy = chatBusy;

  return {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    busy,
    chatBusy,
    graphBusy,
    handleSendFromHistory,
    handleSendFromPanel,
    retryMessage,
    selectedNode,
  };
}
