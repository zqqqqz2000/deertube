import { useCallback, useEffect, useRef, useState } from "react";
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
  const latestFocusIdRef = useRef<string | null>(focusNodeId);

  useEffect(() => {
    latestFocusIdRef.current = focusNodeId ?? null;
  }, [focusNodeId]);

  const handleAutoLayout = useCallback(async () => {
    if (isLayouting || nodes.length === 0) {
      return;
    }
    setIsLayouting(true);
    const resolveDimension = (
      value: number | null | undefined,
      fallback: number | null | undefined,
    ) => {
      if (typeof value === "number" && value > 0) {
        return value;
      }
      if (typeof fallback === "number" && fallback > 0) {
        return fallback;
      }
      return undefined;
    };
    const layoutNodes: FlowNode[] = nodes.map((node) => {
      const internal = flowInstance?.getNode(node.id);
      const width = resolveDimension(internal?.width, node.width);
      const height = resolveDimension(internal?.height, node.height);
      if (width === node.width && height === node.height) {
        return node;
      }
      return { ...node, width, height };
    });
    const { positions } = await layoutFlowWithElk({
      nodes: layoutNodes,
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
      const latestFocusId = latestFocusIdRef.current;
      if (!flowInstance || !latestFocusId) {
        return;
      }
      const focusPosition = positions[latestFocusId];
      const internalNode = flowInstance.getNode(latestFocusId);
      const node =
        layoutNodes.find((item) => item.id === latestFocusId) ??
        internalNode ??
        null;
      if (!node) {
        return;
      }
      const resolvedPosition =
        focusPosition ??
        ("positionAbsolute" in node && node.positionAbsolute
          ? node.positionAbsolute
          : node.position);
      if (!resolvedPosition) {
        return;
      }
      const focusSize = getNodeSize(node);
      const zoom = flowInstance.getZoom();
      flowInstance.setCenter(
        resolvedPosition.x + focusSize.width / 2,
        resolvedPosition.y + focusSize.height / 2,
        { zoom, duration: 350 },
      );
    });
    setIsLayouting(false);
  }, [edges, flowInstance, isLayouting, nodes, setNodes]);

  return { isLayouting, handleAutoLayout };
}
