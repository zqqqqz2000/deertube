import { useCallback, useState } from "react";
import type { ReactFlowInstance } from "reactflow";
import { layoutFlowWithElk } from "../../lib/elkLayout";
import type { FlowEdge, FlowNode } from "../../types/flow";

interface UseAutoLayoutOptions {
  flowInstance: ReactFlowInstance | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
}

export function useAutoLayout({
  flowInstance,
  nodes,
  edges,
  setNodes,
}: UseAutoLayoutOptions) {
  const [isLayouting, setIsLayouting] = useState(false);

  const handleAutoLayout = useCallback(async () => {
    if (isLayouting || nodes.length === 0) {
      return;
    }
    setIsLayouting(true);
    const { positions } = await layoutFlowWithElk({
      nodes,
      edges,
      direction: "RIGHT",
      useExistingPositions: true,
    });
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        position: positions[node.id] ?? node.position,
      })),
    );
    requestAnimationFrame(() => {
      flowInstance?.fitView({ padding: 0.2, duration: 400 });
    });
    setIsLayouting(false);
  }, [edges, flowInstance, isLayouting, nodes, setNodes]);

  return { isLayouting, handleAutoLayout };
}
