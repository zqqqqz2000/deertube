import { useCallback, useState, type MutableRefObject } from "react";
import type { ReactFlowInstance } from "reactflow";
import { placeQuestionNode, placeSourceNodes } from "../../lib/flowPlacement";
import { QUESTION_NODE_WIDTH, SOURCE_NODE_WIDTH } from "../../lib/elkLayout";
import { trpc } from "../../lib/trpc";
import type {
  FlowEdge,
  FlowNode,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../../types/flow";
import type { ProviderProfile } from "../../lib/settings";

interface UseQuestionActionsOptions {
  projectPath: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  lastQuestionId: MutableRefObject<string | null>;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  buildContextSummary: (targetId: string) => string;
}

export function useQuestionActions({
  projectPath,
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedId,
  setSelectedId,
  lastQuestionId,
  flowInstance,
  activeProfile,
  buildContextSummary,
}: UseQuestionActionsOptions) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const handleAsk = useCallback(async () => {
    if (!prompt.trim() || busy || !selectedId) {
      return;
    }
    const questionText = prompt.trim();
    setPrompt("");
    setBusy(true);

    const parentNode = nodes.find((node) => node.id === selectedId) ?? null;
    const parentPosition = parentNode?.position ?? { x: 0, y: 0 };

    const questionId = crypto.randomUUID();
    const questionPosition = await placeQuestionNode({
      parentNode,
      parentPosition,
      questionId,
      nodes,
      edges,
    });
    const questionNode: QuestionNodeType = {
      id: questionId,
      type: "question",
      position: questionPosition,
      data: {
        question: questionText,
        answer: "Searching and reasoning...",
      },
      width: QUESTION_NODE_WIDTH,
    };

    setNodes((prev: FlowNode[]) => [...prev, questionNode]);
    if (selectedId) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: selectedId,
          target: questionId,
          type: "smoothstep",
        },
      ]);
    } else if (lastQuestionId.current) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: lastQuestionId.current,
          target: questionId,
          type: "smoothstep",
        },
      ]);
    }
    lastQuestionId.current = questionId;
    setSelectedId(questionId);

    try {
      const context = selectedId ? buildContextSummary(selectedId) : "";
      const result = await trpc.deepSearch.run.mutate({
        projectPath,
        query: questionText,
        maxResults: 5,
        context,
        settings: activeProfile
          ? {
              tavilyApiKey: activeProfile.tavilyApiKey.trim() || undefined,
              jinaReaderBaseUrl:
                activeProfile.jinaReaderBaseUrl.trim() || undefined,
              jinaReaderApiKey:
                activeProfile.jinaReaderApiKey.trim() || undefined,
              llmProvider: activeProfile.llmProvider.trim() || undefined,
              llmModelId: activeProfile.llmModelId.trim() || undefined,
              llmApiKey: activeProfile.llmApiKey.trim() || undefined,
              llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
            }
          : undefined,
      });

      const sourcePositions = await placeSourceNodes({
        questionId,
        questionPosition,
        nodes,
        edges,
        sources: result.sources.map((source) => ({ id: source.id })),
      });
      const sourceNodes: SourceNodeType[] = result.sources.map(
        (source, index) => ({
          id: source.id,
          type: "source",
          position: sourcePositions[index],
          data: {
            title: source.title,
            url: source.url,
            snippet: source.snippet,
          },
          width: SOURCE_NODE_WIDTH,
        }),
      );

      setNodes((prev: FlowNode[]) =>
        prev
          .map((node) => {
            if (node.id === questionId && node.type === "question") {
              return {
                ...node,
                data: {
                  ...node.data,
                  answer: result.answer,
                },
              };
            }
            return node;
          })
          .concat(sourceNodes),
      );

      const sourceEdges: FlowEdge[] = result.sources.map((source) => ({
        id: crypto.randomUUID(),
        source: questionId,
        target: source.id,
        type: "smoothstep",
      }));
      setEdges((prev: FlowEdge[]) => [...prev, ...sourceEdges]);

      requestAnimationFrame(() => {
        flowInstance?.fitView({ padding: 0.2, duration: 400 });
      });
    } catch {
      setNodes((prev: FlowNode[]) =>
        prev.map((node) => {
          if (node.id === questionId && node.type === "question") {
            return {
              ...node,
              data: {
                ...node.data,
                answer: "Request failed. Please try again.",
              },
            };
          }
          return node;
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [
    activeProfile,
    buildContextSummary,
    busy,
    edges,
    flowInstance,
    nodes,
    projectPath,
    prompt,
    selectedId,
    setEdges,
    setNodes,
    setSelectedId,
    lastQuestionId,
  ]);

  return { prompt, setPrompt, busy, handleAsk };
}
