import { useCallback, useState } from "react";
import type { ReactFlowInstance } from "reactflow";
import { getNodeSize, layoutFlowWithElk } from "../../lib/elkLayout";
import type { FlowEdge, FlowNode } from "../../types/flow";

interface UseAutoLayoutOptions {
  flowInstance: ReactFlowInstance | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  focusNodeId?: string | null;
}

export function useAutoLayout({
  flowInstance,
  nodes,
  edges,
  setNodes,
  focusNodeId = null,
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
    const focusNode = focusNodeId
      ? nodes.find((node) => node.id === focusNodeId) ?? null
      : null;
    const focusPosition = focusNodeId ? positions[focusNodeId] ?? focusNode?.position : null;
    const focusSize = getNodeSize(focusNode);
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        position: positions[node.id] ?? node.position,
      })),
    );
    requestAnimationFrame(() => {
      if (!flowInstance || !focusNodeId || !focusPosition) {
        return;
      }
      const zoom = flowInstance.getZoom();
      flowInstance.setCenter(
        focusPosition.x + focusSize.width / 2,
        focusPosition.y + focusSize.height / 2,
        { zoom, duration: 350 },
      );
    });
    setIsLayouting(false);
  }, [edges, flowInstance, focusNodeId, isLayouting, nodes, setNodes]);

  return { isLayouting, handleAutoLayout };
}
