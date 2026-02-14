import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactFlowInstance } from "reactflow";
import { trpc } from "../../lib/trpc";
import {
  finishRunningChatJob,
  startRunningChatJob,
} from "@/lib/running-chat-jobs";
import type {
  FlowEdge,
  FlowNode,
  InsightNode as InsightNodeType,
  InsightNodeData,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../../types/flow";
import { buildRuntimeSettings, type ProviderProfile } from "../../lib/settings";
import type {
  ChatMessage,
  DeepSearchStreamPayload,
  GraphRunNodePayload,
  SubagentStreamPayload,
  ToolCallEventInput,
} from "../../types/chat";
import { placeInsightNodes } from "../../lib/flowPlacement";
import { INSIGHT_NODE_WIDTH } from "../../lib/elkLayout";
import { useChat } from "@/lib/chat/use-electron-chat";
import type {
  DeertubeMessageMetadata,
  DeertubeUIMessage,
} from "@/modules/ai/tools";
import {
  resolveDeepResearchConfig,
  type DeepResearchConfig,
  type DeepResearchConfigInput,
} from "@/shared/deepresearch-config";
import { isJsonObject } from "@/types/json";
import { useContextBuilder } from "./useContextBuilder";

interface UseChatActionsOptions {
  projectPath: string;
  chatId: string | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  initialMessages: ChatMessage[];
  onBeforeSendPrompt?: (prompt: string) => Promise<void> | void;
}

interface GraphSnapshot {
  nodes: {
    intId: number;
    nodeId: string;
    type: string;
    label?: string;
    excerpt?: string;
  }[];
  edges: { sourceIntId: number; targetIntId: number }[];
}

const CHAT_ACTION_DEBUG_LOGS_ENABLED =
  import.meta.env.DEV &&
  import.meta.env.VITE_CHAT_ACTION_DEBUG_LOGS === "true";
const DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY =
  "deertube:deepResearchConfigByProject";
const GRAPH_AUTOGEN_BY_PROJECT_KEY = "deertube:graphAutoGenByProject";
const CHAT_STREAM_RUNNING_JOB_ID = "chat-stream";

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

const buildGraphSnapshot = (
  nodes: FlowNode[],
  edges: FlowEdge[],
): GraphSnapshot => {
  const nodeIdToIntId = new Map<string, number>();
  const graphNodes = nodes.map((node, index) => {
    const intId = index + 1;
    nodeIdToIntId.set(node.id, intId);
    const nodeType = node.type ?? "unknown";
    if (node.type === "question") {
      const data = node.data as QuestionNodeType["data"];
      return {
        intId,
        nodeId: node.id,
        type: nodeType,
        label: data.question,
        excerpt: data.answer,
      };
    }
    if (node.type === "source") {
      const data = node.data as SourceNodeType["data"];
      return {
        intId,
        nodeId: node.id,
        type: nodeType,
        label: data.title,
        excerpt: data.snippet,
      };
    }
    if (node.type === "insight") {
      const data = node.data as InsightNodeData;
      return {
        intId,
        nodeId: node.id,
        type: nodeType,
        label: data.titleLong,
        excerpt: data.excerpt,
      };
    }
    return { intId, nodeId: node.id, type: nodeType };
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
    .filter(
      (edge): edge is { sourceIntId: number; targetIntId: number } =>
        edge !== null,
    );

  return { nodes: graphNodes, edges: graphEdges };
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

const readLocalStorageJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined" || !window.localStorage) {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const loadDeepResearchConfig = (projectPath: string): DeepResearchConfig => {
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    {},
  );
  return resolveDeepResearchConfig(
    (mapping[projectPath] as DeepResearchConfigInput | null | undefined) ??
      undefined,
  );
};

const saveDeepResearchConfig = (
  projectPath: string,
  config: DeepResearchConfig,
) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    {},
  );
  mapping[projectPath] = config;
  window.localStorage.setItem(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    JSON.stringify(mapping),
  );
};

const loadGraphAutoGenerationEnabled = (projectPath: string): boolean => {
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    {},
  );
  const value = mapping[projectPath];
  return typeof value === "boolean" ? value : true;
};

const saveGraphAutoGenerationEnabled = (
  projectPath: string,
  enabled: boolean,
) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    {},
  );
  mapping[projectPath] = enabled;
  window.localStorage.setItem(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    JSON.stringify(mapping),
  );
};

export function useChatActions({
  projectPath,
  chatId,
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedId,
  flowInstance,
  activeProfile,
  initialMessages,
  onBeforeSendPrompt,
}: UseChatActionsOptions) {
  const [historyInput, setHistoryInput] = useState("");
  const [panelInput, setPanelInput] = useState("");
  const [deepResearchConfig, setDeepResearchConfig] =
    useState<DeepResearchConfig>(() => loadDeepResearchConfig(projectPath));
  const [graphGenerationEnabled, setGraphGenerationEnabled] =
    useState<boolean>(() => loadGraphAutoGenerationEnabled(projectPath));
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphEventMessages, setGraphEventMessages] = useState<ChatMessage[]>(
    () => initialMessages.filter((message) => message.kind === "graph-event"),
  );
  const [persistedSubagentEvents] = useState<ChatMessage[]>(
    () => initialMessages.filter((message) => message.kind === "subagent-event"),
  );
  const [persistedDeepSearchEvents] = useState<ChatMessage[]>(
    () => initialMessages.filter((message) => message.kind === "deepsearch-event"),
  );
  const [asyncDeepSearchEventMessages, setAsyncDeepSearchEventMessages] =
    useState<ChatMessage[]>([]);
  const loggedGraphEventsRef = useRef<Map<string, string>>(new Map());
  const loggedStreamPartsRef = useRef<Map<string, string>>(new Map());
  const fallbackCreatedAtByIdRef = useRef<Map<string, string>>(new Map());
  const lastSubmittedPromptRef = useRef("");
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    setDeepResearchConfig(loadDeepResearchConfig(projectPath));
    setGraphGenerationEnabled(loadGraphAutoGenerationEnabled(projectPath));
  }, [projectPath]);

  useEffect(() => {
    saveDeepResearchConfig(projectPath, deepResearchConfig);
  }, [deepResearchConfig, projectPath]);

  useEffect(() => {
    saveGraphAutoGenerationEnabled(projectPath, graphGenerationEnabled);
  }, [graphGenerationEnabled, projectPath]);

  useEffect(() => {
    if (!CHAT_ACTION_DEBUG_LOGS_ENABLED) {
      return;
    }
    graphEventMessages.forEach((event) => {
      if (event.kind !== "graph-event") {
        return;
      }
      const signature = JSON.stringify({
        content: event.content,
        toolStatus: event.toolStatus,
        toolInput: event.toolInput,
        toolOutput: event.toolOutput,
        error: event.error,
      });
      const previous = loggedGraphEventsRef.current.get(event.id);
      if (previous === signature) {
        return;
      }
      loggedGraphEventsRef.current.set(event.id, signature);
      console.log("[graph-subagent]", event);
    });
  }, [graphEventMessages]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const runtimeSettings = useMemo(
    () => buildRuntimeSettings(activeProfile),
    [activeProfile],
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
  const selectedPathSummary = useMemo(() => {
    if (!selectedId) {
      return undefined;
    }
    const summary = buildContextSummary(selectedId).trim();
    return summary.length > 0 ? summary : undefined;
  }, [buildContextSummary, selectedId]);
  const selectedNodeForQuote = useMemo(
    () =>
      selectedId
        ? (nodes.find((node) => node.id === selectedId) ?? null)
        : null,
    [nodes, selectedId],
  );

  const initialUiMessages = useMemo(
    () =>
      initialMessages
        .filter(
          (message) =>
            message.kind !== "graph-event" &&
            message.kind !== "subagent-event" &&
            message.kind !== "deepsearch-event",
        )
        .map(mapChatToUiMessage),
    [initialMessages],
  );

  const runGraphTools = useCallback(
    async (responseId: string, responseText: string) => {
      if (!responseText.trim()) {
        return;
      }
      const eventId = crypto.randomUUID();
      const runningJobId = `graph:${eventId}`;
      const startedAt = new Date().toISOString();
      if (chatId) {
        startRunningChatJob(projectPath, chatId, runningJobId);
      }
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
          settings: runtimeSettings,
        });

        const graphNodes = result.nodes as GraphRunNodePayload[];
        const nodesAdded = graphNodes.length;
        setGraphEventMessages((prev) =>
          prev.map((event) =>
            event.id === eventId
              ? {
                  ...event,
                  toolStatus: "complete",
                  toolOutput: {
                    nodesAdded,
                    nodes: graphNodes,
                    explanation: result.explanation,
                  },
                }
              : event,
          ),
        );

        if (!nodesAdded) {
          return;
        }

        const workingNodes: FlowNode[] = [...nodes];
        const workingEdges: FlowEdge[] = [...edges];
        const positionMap = new Map<string, { x: number; y: number }>();
        const pendingByParent = new Map<string, GraphRunNodePayload[]>();
        graphNodes.forEach((node) => {
          if (!node.parentId) {
            throw new Error("Graph node missing parentId.");
          }
          const list = pendingByParent.get(node.parentId) ?? [];
          list.push(node);
          pendingByParent.set(node.parentId, list);
        });

        const maxPasses = graphNodes.length + 2;
        let pass = 0;
        let placedInPass = true;

        while (pendingByParent.size > 0 && placedInPass && pass < maxPasses) {
          placedInPass = false;
          for (const [parentId, children] of Array.from(
            pendingByParent.entries(),
          )) {
            const parentNode =
              workingNodes.find((node) => node.id === parentId) ?? null;
            if (!parentNode) {
              continue;
            }
            const parentPosition = parentNode?.position ?? { x: 0, y: 0 };
            const positions = await placeInsightNodes({
              parentNode,
              parentPosition,
              nodes: workingNodes,
              edges: workingEdges,
              insights: children.map((child) => ({ id: child.id })),
            });

            children.forEach((child, index) => {
              const position = positions[index] ?? parentPosition;
              positionMap.set(child.id, position);
              workingNodes.push({
                id: child.id,
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
              workingEdges.push({
                id: crypto.randomUUID(),
                source: parentId,
                target: child.id,
                type: "smoothstep",
              });
            });

            pendingByParent.delete(parentId);
            placedInPass = true;
          }
          pass += 1;
        }

        if (pendingByParent.size > 0) {
          throw new Error(
            `Unresolved parentId(s): ${[...pendingByParent.keys()].join(", ")}`,
          );
        }

        const insightNodes: InsightNodeType[] = graphNodes.map((node) => ({
          id: node.id,
          type: "insight",
          position: positionMap.get(node.id) ?? { x: 0, y: 0 },
          data: {
            titleLong: node.titleLong,
            titleShort: node.titleShort,
            titleTiny: node.titleTiny,
            excerpt: node.excerpt,
            responseId: node.responseId ?? "",
          },
          width: INSIGHT_NODE_WIDTH,
        }));

        setNodes((prev: FlowNode[]) => [...prev, ...insightNodes]);
        const newEdges = graphNodes
          .map((node, index) => {
            return {
              id: crypto.randomUUID(),
              source: node.parentId,
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
        if (chatId) {
          finishRunningChatJob(projectPath, chatId, runningJobId);
        }
        setGraphBusy(false);
      }
    },
    [
      chatId,
      edges,
      flowInstance,
      nodes,
      projectPath,
      runtimeSettings,
      selectedId,
      selectedNodeSummary,
      setEdges,
      setNodes,
    ],
  );

  const runPostAnswerValidation = useCallback(
    async (responseId: string, responseText: string) => {
      if (!deepResearchConfig.enabled || !deepResearchConfig.validate.enabled) {
        return;
      }
      const query = lastSubmittedPromptRef.current.trim() || responseText.trim();
      if (!query) {
        return;
      }
      const toolCallId = `validate-${crypto.randomUUID()}`;
      const eventId = `deepsearch-${toolCallId}`;
      const runningJobId = `validate:${toolCallId}`;
      const startedAt = new Date().toISOString();
      if (chatId) {
        startRunningChatJob(projectPath, chatId, runningJobId);
      }
      setAsyncDeepSearchEventMessages((prev) => [
        ...prev,
        {
          id: eventId,
          role: "assistant",
          content: "",
          createdAt: startedAt,
          kind: "deepsearch-event",
          toolName: "validate.run",
          toolStatus: "running",
          toolInput: {
            responseId,
            toolCallId,
          },
          toolOutput: {
            toolCallId,
            toolName: "validate.run",
            mode: "validate",
            query,
            status: "running",
          } satisfies DeepSearchStreamPayload,
        },
      ]);
      try {
        const result = await trpc.chat.validate.mutate({
          projectPath,
          query,
          answer: responseText,
          settings: runtimeSettings,
          deepResearch: deepResearchConfig,
        });
        if (!mountedRef.current) {
          return;
        }
        setAsyncDeepSearchEventMessages((prev) =>
          prev.map((event) =>
            event.id !== eventId
              ? event
              : {
                  ...event,
                  toolStatus: result.status === "complete" ? "complete" : "failed",
                  toolOutput: {
                    toolCallId,
                    toolName: "validate.run",
                    mode: "validate",
                    query: result.query,
                    projectId: result.projectId,
                    searchId: result.searchId,
                    status: result.status === "complete" ? "complete" : "failed",
                    sources: result.sources,
                    references: result.references,
                    error:
                      result.status === "skipped"
                        ? "Validation skipped by config."
                        : undefined,
                    complete: true,
                  } satisfies DeepSearchStreamPayload,
                  error:
                    result.status === "skipped"
                      ? "Validation skipped by config."
                      : undefined,
                },
          ),
        );
      } catch (err) {
        if (!mountedRef.current) {
          return;
        }
        const errorMessage =
          err instanceof Error ? err.message : "Post-answer validation failed";
        setAsyncDeepSearchEventMessages((prev) =>
          prev.map((event) =>
            event.id !== eventId
              ? event
              : {
                  ...event,
                  toolStatus: "failed",
                  error: errorMessage,
                  toolOutput: {
                    toolCallId,
                    toolName: "validate.run",
                    mode: "validate",
                    query,
                    status: "failed",
                    error: errorMessage,
                    complete: true,
                  } satisfies DeepSearchStreamPayload,
                },
          ),
        );
      } finally {
        if (chatId) {
          finishRunningChatJob(projectPath, chatId, runningJobId);
        }
      }
    },
    [chatId, deepResearchConfig, projectPath, runtimeSettings],
  );

  const { messages, sendMessage, regenerate, status, error, stop } =
    useChat<DeertubeUIMessage>({
      messages: initialUiMessages,
      context: {
        projectPath,
        selectedNodeSummary,
        selectedPathSummary,
        deepResearch: deepResearchConfig,
        settings: runtimeSettings,
      },
      onFinish: ({ message }: { message?: DeertubeUIMessage }) => {
        if (!message || message.role !== "assistant") {
          return;
        }
        const text = extractUiMessageText(message);
        if (!text.trim()) {
          return;
        }
        void runPostAnswerValidation(message.id, text);
        if (!graphGenerationEnabled) {
          return;
        }
        void runGraphTools(message.id, text);
      },
    });
  useEffect(() => {
    if (!chatId) {
      return;
    }
    const isStreaming = status === "streaming" || status === "submitted";
    if (isStreaming) {
      startRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    } else {
      finishRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    }
    return () => {
      finishRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    };
  }, [chatId, projectPath, status]);
  useEffect(() => {
    if (!CHAT_ACTION_DEBUG_LOGS_ENABLED) {
      return;
    }
    messages.forEach((message) => {
      if (!Array.isArray(message.parts)) {
        return;
      }
      message.parts.forEach((part) => {
        const subagentPayload = readSubagentPartPayload(part);
        const deepSearchPart = subagentPayload
          ? null
          : readDeepSearchPartPayload(part);
        const deepSearchPayload = deepSearchPart?.payload;
        const payload = subagentPayload ?? deepSearchPayload;
        if (!payload) {
          return;
        }
        const partType = subagentPayload ? "data-subagent-stream" : part.type;
        const key = `${message.id}-${partType}-${payload.toolCallId}`;
        const signature = JSON.stringify(payload);
        const previous = loggedStreamPartsRef.current.get(key);
        if (previous === signature) {
          return;
        }
        loggedStreamPartsRef.current.set(key, signature);
        if (subagentPayload) {
          console.log("[ui.subagent.stream]", {
            toolCallId: subagentPayload.toolCallId,
            toolName: subagentPayload.toolName,
            messages: subagentPayload.messages.length,
          });
        } else {
          if (!deepSearchPayload) {
            return;
          }
          console.log("[ui.deepsearch.stream]", {
            toolCallId: deepSearchPayload.toolCallId,
            toolName: deepSearchPayload.toolName,
            status: deepSearchPayload.status,
            query: deepSearchPayload.query,
            sources: deepSearchPayload.sources?.length ?? 0,
            conclusionLength: deepSearchPayload.conclusion?.length ?? 0,
            error: deepSearchPayload.error,
          });
        }
      });
    });
  }, [messages]);

  const derivedMessages = useMemo(() => {
    const mapped = mapUiMessagesToChat(
      messages,
      status,
      error,
      fallbackCreatedAtByIdRef.current,
    );
    const withGraphEvents = graphEventMessages.length
      ? mergeGraphEvents(mapped, graphEventMessages)
      : mapped;
    const runtimeDeepSearchEvents = mergePersistedAgentEvents(
      asyncDeepSearchEventMessages,
      buildDeepSearchEvents(messages, status),
    );
    const deepSearchEvents = mergePersistedAgentEvents(
      persistedDeepSearchEvents,
      runtimeDeepSearchEvents,
    );
    const deepSearchStatusByToolCall = buildAgentToolStatusByToolCall(
      deepSearchEvents,
      "deepsearch-event",
    );
    const subagentEvents = mergePersistedAgentEvents(
      persistedSubagentEvents,
      buildSubagentEvents(messages, status, deepSearchStatusByToolCall),
    );
    const withSubagentEvents = subagentEvents.length
      ? mergeSubagentEvents(withGraphEvents, subagentEvents)
      : withGraphEvents;
    if (!deepSearchEvents.length) {
      return withSubagentEvents;
    }
    return mergeDeepSearchEvents(withSubagentEvents, deepSearchEvents);
  }, [
    messages,
    status,
    error,
    graphEventMessages,
    asyncDeepSearchEventMessages,
    persistedSubagentEvents,
    persistedDeepSearchEvents,
  ]);

  const sendPrompt = useCallback(
    async (rawPrompt: string, reset: () => void) => {
      if (!rawPrompt.trim()) {
        return;
      }
      const prompt = rawPrompt.trim();
      try {
        await onBeforeSendPrompt?.(prompt);
      } catch {
        // Keep chat usable even when local persistence fails.
      }
      const quotePrefix =
        selectedNodeForQuote && !hasNodeQuote(prompt)
          ? `${buildNodeQuote(selectedNodeForQuote)} `
          : "";
      const finalPrompt = `${quotePrefix}${prompt}`;
      lastSubmittedPromptRef.current = prompt;
      reset();
      if (status === "streaming" || status === "submitted") {
        void stop();
      }
      void sendMessage({ text: finalPrompt });
    },
    [onBeforeSendPrompt, selectedNodeForQuote, sendMessage, status, stop],
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

  const stopChatGeneration = useCallback(() => {
    void stop();
  }, [stop]);

  const busy = status === "streaming" || status === "submitted";

  return {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    deepResearchConfig,
    setDeepResearchConfig,
    graphGenerationEnabled,
    setGraphGenerationEnabled,
    busy,
    chatBusy: busy,
    graphBusy,
    handleSendFromHistory,
    handleSendFromPanel,
    stopChatGeneration,
    retryMessage,
    selectedNode,
    messages: derivedMessages,
  };
}

function mapChatToUiMessage(message: ChatMessage): DeertubeUIMessage {
  const metadata =
    (message.status ?? message.error)
      ? {
          status: message.status,
          error: message.error,
        }
      : undefined;
  return {
    id: message.id,
    role: message.role,
    metadata,
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

function extractMessageMetadata(
  metadata: DeertubeMessageMetadata | null | undefined,
): { status?: ChatMessage["status"]; error?: string } {
  if (!metadata) {
    return {};
  }
  const status =
    metadata.status === "pending" ||
    metadata.status === "complete" ||
    metadata.status === "failed"
      ? metadata.status
      : undefined;
  const error = typeof metadata.error === "string" ? metadata.error : undefined;
  return { status, error };
}

type DeertubeMessagePart = DeertubeUIMessage["parts"][number];

const isSubagentStreamPayload = (
  value: unknown,
): value is SubagentStreamPayload => {
  if (!isJsonObject(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toolCallId === "string" &&
    Array.isArray(candidate.messages)
  );
};

const isDeepSearchStreamPayload = (
  value: unknown,
): value is DeepSearchStreamPayload => {
  if (!isJsonObject(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.toolCallId === "string";
};

const readSubagentPartPayload = (
  part: DeertubeMessagePart,
): SubagentStreamPayload | null => {
  if (part.type !== "data-subagent-stream") {
    return null;
  }
  const payload = (part as { data?: unknown }).data;
  return isSubagentStreamPayload(payload) ? payload : null;
};

const readDeepSearchPartPayload = (
  part: DeertubeMessagePart,
): { payload: DeepSearchStreamPayload; done: boolean } | null => {
  if (
    part.type !== "data-deepsearch-stream" &&
    part.type !== "data-deepsearch-done"
  ) {
    return null;
  }
  const payload = (part as { data?: unknown }).data;
  if (!isDeepSearchStreamPayload(payload)) {
    return null;
  }
  return {
    payload,
    done: part.type === "data-deepsearch-done",
  };
};

const readKnownToolStatus = (value: unknown): ChatMessage["toolStatus"] | null => {
  if (value === "running" || value === "complete" || value === "failed") {
    return value;
  }
  return null;
};

const readToolPartResultStatus = (
  part: DeertubeMessagePart,
): ChatMessage["toolStatus"] | null => {
  const partState =
    "state" in part && typeof part.state === "string" ? part.state : undefined;
  const hasErrorState =
    (partState?.includes("error") ?? false) ||
    (partState?.includes("denied") ?? false);
  if (hasErrorState) {
    return "failed";
  }
  if ("output" in part && part.output !== undefined) {
    if (isJsonObject(part.output)) {
      const status = readKnownToolStatus(part.output.status);
      if (status) {
        return status;
      }
    }
    return "complete";
  }
  if (partState === "output-available") {
    return "complete";
  }
  return null;
};

const isToolExecutionPart = (part: DeertubeMessagePart): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

const deriveSubagentResultStatus = (
  payload: SubagentStreamPayload,
): ChatMessage["toolStatus"] | null => {
  const lastMessage = payload.messages.at(-1);
  if (
    !lastMessage ||
    typeof lastMessage !== "object" ||
    !("parts" in lastMessage) ||
    !Array.isArray((lastMessage as { parts?: unknown }).parts)
  ) {
    return null;
  }
  const parts = (lastMessage as { parts: DeertubeMessagePart[] }).parts;
  const statuses = parts
    .filter(isToolExecutionPart)
    .map((part) => readToolPartResultStatus(part))
    .filter((status): status is ChatMessage["toolStatus"] => status !== null);
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("running")) {
    return "running";
  }
  if (statuses.includes("complete")) {
    return "complete";
  }
  return null;
};

const deriveDeepSearchResultStatus = (
  payload: DeepSearchStreamPayload,
  done: boolean,
): ChatMessage["toolStatus"] | null => {
  const payloadStatus = readKnownToolStatus(payload.status);
  if (payloadStatus === "failed") {
    return "failed";
  }
  if (payloadStatus === "complete") {
    return "complete";
  }
  if (done) {
    return "complete";
  }
  const hasError =
    typeof payload.error === "string" && payload.error.trim().length > 0;
  if (hasError) {
    return "failed";
  }
  const hasConclusion =
    typeof payload.conclusion === "string" && payload.conclusion.trim().length > 0;
  const hasSources = Array.isArray(payload.sources) && payload.sources.length > 0;
  const hasReferences =
    Array.isArray(payload.references) && payload.references.length > 0;
  if (hasConclusion || hasSources || hasReferences) {
    return payloadStatus ?? "complete";
  }
  return payloadStatus;
};

const resolveToolStatusByChatState = ({
  resultStatus,
  isActiveAssistantMessage,
  isStreaming,
}: {
  resultStatus: ChatMessage["toolStatus"] | null;
  isActiveAssistantMessage: boolean;
  isStreaming: boolean;
}): ChatMessage["toolStatus"] => {
  if (resultStatus) {
    return resultStatus;
  }
  if (isActiveAssistantMessage && isStreaming) {
    return "running";
  }
  return "failed";
};

const extractDeepSearchToolText = (part: DeertubeMessagePart): string | null => {
  const isDeepSearchToolPart =
    part.type === "tool-deepSearch" ||
    (part.type === "dynamic-tool" &&
      "toolName" in part &&
      part.toolName === "deepSearch");
  if (!isDeepSearchToolPart || !("output" in part)) {
    return null;
  }
  if (!isJsonObject(part.output)) {
    return null;
  }
  const answer = part.output.answer;
  if (typeof answer === "string" && answer.trim().length > 0) {
    return answer;
  }
  const conclusion = part.output.conclusion;
  if (typeof conclusion === "string" && conclusion.trim().length > 0) {
    return conclusion;
  }
  return null;
};

function extractUiMessageText(message: DeertubeUIMessage): string {
  if ("content" in message && typeof message.content === "string") {
    return message.content;
  }
  if (!("parts" in message) || !Array.isArray(message.parts)) {
    return "";
  }
  for (const part of message.parts) {
    const toolText = extractDeepSearchToolText(part);
    if (toolText) {
      return toolText;
    }
    const deepSearch = readDeepSearchPartPayload(part);
    if (!deepSearch) {
      continue;
    }
    const conclusion = deepSearch.payload.conclusion;
    if (typeof conclusion === "string" && conclusion.trim().length > 0) {
      return conclusion;
    }
  }
  const text = message.parts
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
  if (text.trim().length > 0) {
    return text;
  }
  return "";
}

function buildSubagentEvents(
  messages: DeertubeUIMessage[],
  status: string,
  deepSearchStatusByToolCall: Map<string, ChatMessage["toolStatus"]>,
): ChatMessage[] {
  const byToolCall = new Map<
    string,
    {
      payload: SubagentStreamPayload;
      parentMessageId: string;
      createdAt: string;
    }
  >();
  const isStreaming = status === "streaming" || status === "submitted";
  const activeAssistantMessageId = isStreaming
    ? getLatestAssistantMessageId(messages)
    : null;

  messages.forEach((message) => {
    if (!Array.isArray(message.parts)) {
      return;
    }
    message.parts.forEach((part) => {
      const payload = readSubagentPartPayload(part);
      if (!payload) {
        return;
      }
      const createdAt =
        "createdAt" in message && message.createdAt
          ? message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : String(message.createdAt)
          : new Date().toISOString();
      byToolCall.set(payload.toolCallId, {
        payload,
        parentMessageId: message.id,
        createdAt,
      });
    });
  });

  return Array.from(byToolCall.values()).map(
    ({ payload, parentMessageId, createdAt }) => {
      const resultStatusFromDeepSearch = deepSearchStatusByToolCall.get(
        payload.toolCallId,
      );
      const resultStatus =
        resultStatusFromDeepSearch ?? deriveSubagentResultStatus(payload);
      const toolStatus = resolveToolStatusByChatState({
        resultStatus,
        isActiveAssistantMessage:
          parentMessageId === activeAssistantMessageId,
        isStreaming,
      });
      return {
        id: `subagent-${payload.toolCallId}`,
        role: "assistant",
        content: "",
        createdAt,
        kind: "subagent-event",
        toolName: payload.toolName,
        toolInput: {
          responseId: parentMessageId,
          toolCallId: payload.toolCallId,
        },
        toolOutput: payload,
        toolStatus,
      };
    },
  );
}

function buildDeepSearchEvents(
  messages: DeertubeUIMessage[],
  status: string,
): ChatMessage[] {
  const byToolCall = new Map<
    string,
    {
      payload: DeepSearchStreamPayload;
      parentMessageId: string;
      createdAt: string;
      done: boolean;
    }
  >();
  const isStreaming = status === "streaming" || status === "submitted";
  const activeAssistantMessageId = isStreaming
    ? getLatestAssistantMessageId(messages)
    : null;

  messages.forEach((message) => {
    if (!Array.isArray(message.parts)) {
      return;
    }
    message.parts.forEach((part) => {
      const deepSearchPart = readDeepSearchPartPayload(part);
      if (!deepSearchPart) {
        return;
      }
      const { payload, done: doneByPartType } = deepSearchPart;
      const createdAt =
        "createdAt" in message && message.createdAt
          ? message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : String(message.createdAt)
          : new Date().toISOString();
      const done =
        doneByPartType ||
        payload.complete === true ||
        payload.status === "complete" ||
        payload.status === "failed";
      byToolCall.set(payload.toolCallId, {
        payload,
        parentMessageId: message.id,
        createdAt,
        done,
      });
    });
  });

  return Array.from(byToolCall.values()).map(
    ({ payload, parentMessageId, createdAt, done }) => {
      const resultStatus = deriveDeepSearchResultStatus(payload, done);
      const toolStatus = resolveToolStatusByChatState({
        resultStatus,
        isActiveAssistantMessage:
          parentMessageId === activeAssistantMessageId,
        isStreaming,
      });
      return {
        id: `deepsearch-${payload.toolCallId}`,
        role: "assistant",
        content: "",
        createdAt,
        kind: "deepsearch-event",
        toolName: payload.toolName,
        toolInput: {
          responseId: parentMessageId,
          toolCallId: payload.toolCallId,
        },
        toolOutput: payload,
        toolStatus,
        error:
          typeof payload.error === "string" && payload.error.trim().length > 0
            ? payload.error
            : undefined,
      };
    },
  );
}

function mapUiMessagesToChat(
  messages: DeertubeUIMessage[],
  status: string,
  error: Error | undefined,
  fallbackCreatedAtById: Map<string, string>,
): ChatMessage[] {
  const activeMessageIds = new Set(messages.map((message) => message.id));
  Array.from(fallbackCreatedAtById.keys()).forEach((messageId) => {
    if (activeMessageIds.has(messageId)) {
      return;
    }
    fallbackCreatedAtById.delete(messageId);
  });
  const mapped: ChatMessage[] = messages.map((message) => {
    const content = extractUiMessageText(message);
    const createdAt = (() => {
      if ("createdAt" in message && message.createdAt) {
        return message.createdAt instanceof Date
          ? message.createdAt.toISOString()
          : String(message.createdAt);
      }
      const existing = fallbackCreatedAtById.get(message.id);
      if (existing) {
        return existing;
      }
      const next = new Date().toISOString();
      fallbackCreatedAtById.set(message.id, next);
      return next;
    })();
    const { status: persistedStatus, error: persistedError } =
      extractMessageMetadata(message.metadata);
    const resolvedError = persistedError;
    const resolvedStatus = persistedStatus;
    return {
      id: message.id,
      role: message.role as ChatMessage["role"],
      content,
      createdAt,
      status: resolvedStatus,
      error: resolvedError,
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
      lastAssistant.error = undefined;
    } else if (status === "error") {
      lastAssistant.status = "failed";
      lastAssistant.error = error?.message ?? "Request failed";
    } else {
      if (!lastAssistant.status) {
        lastAssistant.status = "complete";
      }
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

  const residualEvents: ChatMessage[] = [];
  if (byResponseId.size > 0) {
    byResponseId.forEach((events) => residualEvents.push(...events));
  }
  if (unattached.length > 0) {
    residualEvents.push(...unattached);
  }

  return insertResidualEventsByCreatedAt(merged, residualEvents);
}

function mergePersistedAgentEvents(
  persisted: ChatMessage[],
  runtime: ChatMessage[],
): ChatMessage[] {
  if (persisted.length === 0) {
    return runtime;
  }
  if (runtime.length === 0) {
    return persisted;
  }
  const byId = new Map<string, ChatMessage>();
  persisted.forEach((message) => {
    byId.set(message.id, message);
  });
  runtime.forEach((message) => {
    byId.set(message.id, message);
  });
  return Array.from(byId.values());
}

function mergeSubagentEvents(
  messages: ChatMessage[],
  subagentEvents: ChatMessage[],
): ChatMessage[] {
  if (subagentEvents.length === 0) {
    return messages;
  }
  const byResponseId = new Map<string, ChatMessage[]>();
  const unattached: ChatMessage[] = [];

  subagentEvents.forEach((event) => {
    const responseId = getSubagentEventResponseId(event);
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

  const residualEvents: ChatMessage[] = [];
  if (byResponseId.size > 0) {
    byResponseId.forEach((events) => residualEvents.push(...events));
  }
  if (unattached.length > 0) {
    residualEvents.push(...unattached);
  }

  return insertResidualEventsByCreatedAt(merged, residualEvents);
}

function mergeDeepSearchEvents(
  messages: ChatMessage[],
  deepSearchEvents: ChatMessage[],
): ChatMessage[] {
  if (deepSearchEvents.length === 0) {
    return messages;
  }
  const byResponseId = new Map<string, ChatMessage[]>();
  const unattached: ChatMessage[] = [];

  deepSearchEvents.forEach((event) => {
    const responseId = getDeepSearchEventResponseId(event);
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

  const residualEvents: ChatMessage[] = [];
  if (byResponseId.size > 0) {
    byResponseId.forEach((events) => residualEvents.push(...events));
  }
  if (unattached.length > 0) {
    residualEvents.push(...unattached);
  }

  return insertResidualEventsByCreatedAt(merged, residualEvents);
}

const toMessageTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
};

const insertResidualEventsByCreatedAt = (
  baseMessages: ChatMessage[],
  residualEvents: ChatMessage[],
): ChatMessage[] => {
  if (residualEvents.length === 0) {
    return baseMessages;
  }
  const sortedResidualEvents = [...residualEvents].sort((left, right) => {
    const leftTimestamp = toMessageTimestamp(left.createdAt);
    const rightTimestamp = toMessageTimestamp(right.createdAt);
    return leftTimestamp - rightTimestamp;
  });
  const merged = [...baseMessages];
  sortedResidualEvents.forEach((event) => {
    const eventTimestamp = toMessageTimestamp(event.createdAt);
    const insertIndex = merged.findIndex(
      (message) => toMessageTimestamp(message.createdAt) > eventTimestamp,
    );
    if (insertIndex < 0) {
      merged.push(event);
      return;
    }
    merged.splice(insertIndex, 0, event);
  });
  return merged;
};

function getLatestAssistantMessageId(
  messages: DeertubeUIMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message.id;
    }
  }
  return null;
}

function buildAgentToolStatusByToolCall(
  events: ChatMessage[],
  kind: "subagent-event" | "deepsearch-event",
): Map<string, ChatMessage["toolStatus"]> {
  const statusByToolCall = new Map<string, ChatMessage["toolStatus"]>();
  events.forEach((event) => {
    if (event.kind !== kind) {
      return;
    }
    const toolCallId = readToolCallId(event.toolInput);
    if (!toolCallId || !event.toolStatus) {
      return;
    }
    statusByToolCall.set(toolCallId, event.toolStatus);
  });
  return statusByToolCall;
}

function isToolCallEventInput(
  input: ChatMessage["toolInput"],
): input is ToolCallEventInput {
  if (!input || !isJsonObject(input)) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.responseId === "string" &&
    typeof candidate.toolCallId === "string"
  );
}

function readResponseId(input: ChatMessage["toolInput"]): string | null {
  if (isToolCallEventInput(input)) {
    return input.responseId;
  }
  if (!input || !isJsonObject(input)) {
    return null;
  }
  const responseId = input.responseId;
  return typeof responseId === "string" ? responseId : null;
}

function readToolCallId(input: ChatMessage["toolInput"]): string | null {
  if (isToolCallEventInput(input)) {
    return input.toolCallId;
  }
  if (!input || !isJsonObject(input)) {
    return null;
  }
  const toolCallId = input.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : null;
}

function getGraphEventResponseId(event: ChatMessage): string | null {
  if (event.kind !== "graph-event") {
    return null;
  }
  return readResponseId(event.toolInput);
}

function getSubagentEventResponseId(event: ChatMessage): string | null {
  if (event.kind !== "subagent-event") {
    return null;
  }
  return readResponseId(event.toolInput);
}

function getDeepSearchEventResponseId(event: ChatMessage): string | null {
  if (event.kind !== "deepsearch-event") {
    return null;
  }
  return readResponseId(event.toolInput);
}
