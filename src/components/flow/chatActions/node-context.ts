import type {
  FlowEdge,
  FlowNode,
  InsightNodeData,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "@/types/flow";

export interface GraphSnapshot {
  nodes: {
    intId: number;
    nodeId: string;
    type: string;
    label?: string;
    excerpt?: string;
  }[];
  edges: { sourceIntId: number; targetIntId: number }[];
}

export const isStartNode = (node: FlowNode | null) => {
  if (!node || node.type !== "insight") {
    return false;
  }
  const data = node.data as InsightNodeData;
  return data.responseId === "" && data.titleShort === "Start";
};

export const buildNodeContext = (node: FlowNode | null) => {
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

export const buildGraphSnapshot = (
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

export const hasNodeQuote = (text: string) =>
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

export const buildNodeQuote = (node: FlowNode | null) => {
  if (!node) {
    return "";
  }
  const rawLabel = resolveNodeLabel(node);
  const label = rawLabel.length > 64 ? `${rawLabel.slice(0, 64)}…` : rawLabel;
  return `[[node:${node.id}|${label}]]`;
};
