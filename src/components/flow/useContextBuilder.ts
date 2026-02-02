import { useCallback } from "react";
import type {
  FlowEdge,
  FlowNode,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../../types/flow";

export function useContextBuilder(nodes: FlowNode[], edges: FlowEdge[]) {
  const buildContextPath = useCallback(
    (targetId: string) => {
      const visited = new Set<string>();
      const pathNodes: FlowNode[] = [];
      let currentId: string | null = targetId;

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const currentNode = nodes.find((node) => node.id === currentId);
        if (!currentNode) {
          break;
        }
        pathNodes.push(currentNode);
        const parentEdge = edges.find((edge) => edge.target === currentId);
        currentId = parentEdge?.source ?? null;
      }

      return pathNodes.reverse();
    },
    [edges, nodes],
  );

  const buildContextSummary = useCallback(
    (targetId: string) => {
      const path = buildContextPath(targetId);
      if (path.length === 0) {
        return "";
      }
      return path
        .map((node) => {
          if (node.type === "question") {
            const data = node.data as QuestionNodeType["data"];
            return `Q: ${data.question}\nA: ${data.answer}`;
          }
          if (node.type === "source") {
            const data = node.data as SourceNodeType["data"];
            return `Source: ${data.title}\n${data.url}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    },
    [buildContextPath],
  );
  const buildContextEdgeIds = useCallback(
    (targetId: string) => {
      const visited = new Set<string>();
      const edgeIds: string[] = [];
      let currentId: string | null = targetId;

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const parentEdge = edges.find((edge) => edge.target === currentId);
        if (!parentEdge) {
          break;
        }
        edgeIds.push(parentEdge.id);
        currentId = parentEdge.source;
      }

      return edgeIds;
    },
    [edges],
  );
  const buildQaContext = useCallback(
    (targetId: string) => {
      const path = buildContextPath(targetId);
      if (path.length === 0) {
        return "";
      }
      return path
        .map((node) => {
          if (node.type !== "question") {
            return "";
          }
          const data = node.data as QuestionNodeType["data"];
          return `Q: ${data.question}\nA: ${data.answer}`;
        })
        .filter(Boolean)
        .join("\n\n");
    },
    [buildContextPath],
  );

  return { buildContextSummary, buildQaContext, buildContextEdgeIds };
}
