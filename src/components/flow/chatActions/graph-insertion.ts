import { INSIGHT_NODE_WIDTH } from "@/lib/elkLayout";
import { placeInsightNodes } from "@/lib/flowPlacement";
import type { GraphRunNodePayload } from "@/types/chat";
import type {
  FlowEdge,
  FlowNode,
  InsightNode as InsightNodeType,
} from "@/types/flow";

interface PlanGraphInsertionOptions {
  baseNodes: FlowNode[];
  baseEdges: FlowEdge[];
  graphNodes: GraphRunNodePayload[];
}

interface PlannedGraphInsertion {
  insightNodes: InsightNodeType[];
  newEdges: FlowEdge[];
}

const createPlacementSeedNode = (
  id: string,
  position: { x: number; y: number },
): FlowNode => ({
  id,
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

export async function planGraphInsightInsertion({
  baseNodes,
  baseEdges,
  graphNodes,
}: PlanGraphInsertionOptions): Promise<PlannedGraphInsertion> {
  if (graphNodes.length === 0) {
    return { insightNodes: [], newEdges: [] };
  }

  const workingNodes: FlowNode[] = [...baseNodes];
  const workingEdges: FlowEdge[] = [...baseEdges];
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

    for (const [parentId, children] of Array.from(pendingByParent.entries())) {
      const parentNode = workingNodes.find((node) => node.id === parentId) ?? null;
      if (!parentNode) {
        continue;
      }
      const parentPosition = parentNode.position ?? { x: 0, y: 0 };
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
        workingNodes.push(createPlacementSeedNode(child.id, position));
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

  const newEdges: FlowEdge[] = graphNodes.map((node) => {
    if (!node.parentId) {
      throw new Error("Graph node missing parentId.");
    }
    return {
      id: crypto.randomUUID(),
      source: node.parentId,
      target: node.id,
      type: "smoothstep",
    };
  });

  return { insightNodes, newEdges };
}
