import { useEffect, useRef } from "react";
import { useEdgesState, useNodesState } from "reactflow";
import { INSIGHT_NODE_WIDTH } from "../../lib/elkLayout";
import type {
  FlowEdge,
  FlowNodeData,
  InsightNode as InsightNodeType,
} from "../../types/flow";
import type { ProjectState } from "./types";

interface FlowStateOptions {
  onInitialRootSelect?: (rootId: string) => void;
}

export function useFlowState(
  initialState: ProjectState,
  options?: FlowStateOptions,
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>(
    initialState.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialState.edges,
  );
  const lastQuestionId = useRef<string | null>(null);
  const hydrated = useRef(false);

  const onInitialRootSelect = options?.onInitialRootSelect;

  useEffect(() => {
    if (initialState.nodes.length === 0) {
      const rootId = crypto.randomUUID();
      const rootNode: InsightNodeType = {
        id: rootId,
        type: "insight",
        position: { x: 0, y: 0 },
        data: {
          titleLong: "Start here",
          titleShort: "Start",
          titleTiny: "S",
          excerpt: "Select a node and ask a question to grow the graph.",
          responseId: "",
        },
        width: INSIGHT_NODE_WIDTH,
      };
      setNodes([rootNode]);
      setEdges([]);
      lastQuestionId.current = rootId;
      onInitialRootSelect?.(rootId);
    } else {
      setNodes(initialState.nodes);
      setEdges(initialState.edges);
      const lastInsight = [...initialState.nodes]
        .filter((node) => node.type === "insight")
        .slice(-1)[0];
      lastQuestionId.current = lastInsight?.id ?? null;
    }
    hydrated.current = true;
  }, [
    initialState.edges,
    initialState.nodes,
    setEdges,
    setNodes,
    onInitialRootSelect,
  ]);

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
