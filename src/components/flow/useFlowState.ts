import { useEffect, useRef } from "react";
import { useEdgesState, useNodesState } from "reactflow";
import { trpc } from "../../lib/trpc";
import { QUESTION_NODE_WIDTH } from "../../lib/elkLayout";
import type {
  FlowEdge,
  FlowNodeData,
  QuestionNode as QuestionNodeType,
} from "../../types/flow";
import type { ProjectState } from "./types";

interface FlowStateOptions {
  onInitialRootSelect?: (rootId: string) => void;
}

export function useFlowState(
  initialState: ProjectState,
  projectPath: string,
  options: FlowStateOptions = {},
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>(
    initialState.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialState.edges,
  );
  const lastQuestionId = useRef<string | null>(null);
  const hydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (initialState.nodes.length === 0) {
      const rootId = crypto.randomUUID();
      const rootNode: QuestionNodeType = {
        id: rootId,
        type: "question",
        position: { x: 0, y: 0 },
        data: {
          question: "Start here",
          answer: "Select this node to ask your first question.",
        },
        width: QUESTION_NODE_WIDTH,
      };
      setNodes([rootNode]);
      setEdges([]);
      lastQuestionId.current = rootId;
      trpc.project.saveState
        .mutate({
          path: projectPath,
          state: {
            nodes: [rootNode],
            edges: [],
            version: 1,
          },
        })
        .catch(() => undefined);
      options.onInitialRootSelect?.(rootId);
    } else {
      setNodes(initialState.nodes);
      setEdges(initialState.edges);
      const lastQuestion = [...initialState.nodes]
        .filter((node) => node.type === "question")
        .slice(-1)[0];
      lastQuestionId.current = lastQuestion?.id ?? null;
    }
    hydrated.current = true;
  }, [
    initialState.edges,
    initialState.nodes,
    projectPath,
    setEdges,
    setNodes,
    options,
  ]);

  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      trpc.project.saveState
        .mutate({
          path: projectPath,
          state: {
            nodes,
            edges,
            version: 1,
          },
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [edges, nodes, projectPath]);

  return {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    lastQuestionId,
    hydrated,
  };
}
