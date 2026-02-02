import type { FlowNode, SourceNodeData } from "../types/flow";
import {
  QUESTION_NODE_HEIGHT,
  QUESTION_NODE_WIDTH,
  SOURCE_NODE_HEIGHT,
  SOURCE_NODE_WIDTH,
  layoutFlowWithElk,
  layoutQuestionWithElk,
  resolveColumnPosition,
  resolveRightBiasedPosition,
} from "./elkLayout";

interface Point {
  x: number;
  y: number;
}

interface QuestionPlacementInput {
  parentNode: FlowNode | null;
  parentPosition: Point;
  questionId: string;
  nodes: FlowNode[];
  edges: { id?: string; source: string; target: string }[];
}

interface SourcePlacementInput {
  questionId: string;
  questionPosition: Point;
  nodes: FlowNode[];
  edges: { id?: string; source: string; target: string }[];
  sources: { id: string }[];
}

export const placeQuestionNode = async ({
  parentNode,
  parentPosition,
  questionId,
  nodes,
  edges,
}: QuestionPlacementInput): Promise<Point> => {
  if (parentNode) {
    console.log(questionId, "que");
    const { positions } = await layoutFlowWithElk({
      nodes: [
        ...nodes,
        {
          id: questionId,
          type: "question",
          data: { question: "", answer: "", new: true },
          width: QUESTION_NODE_WIDTH,
        },
      ],
      edges: [...edges, { source: parentNode.id, target: questionId }],
      direction: "RIGHT",
      useExistingPositions: true,
    });
    console.log(positions);
    const placed = positions[questionId];
    if (placed) {
      return resolveRightBiasedPosition({
        desired: placed,
        nodes,
        size: { width: QUESTION_NODE_WIDTH, height: QUESTION_NODE_HEIGHT },
      });
    }
  }
  const elkQuestionPosition = await layoutQuestionWithElk({
    parent: parentNode,
    parentPosition,
    questionId,
  });
  return resolveRightBiasedPosition({
    desired: elkQuestionPosition,
    nodes,
    size: { width: QUESTION_NODE_WIDTH, height: QUESTION_NODE_HEIGHT },
  });
};

export const placeSourceNodes = async ({
  questionId,
  questionPosition,
  nodes,
  edges,
  sources,
}: SourcePlacementInput): Promise<Point[]> => {
  const layoutNodes: FlowNode[] = [
    ...nodes,
    {
      id: questionId,
      type: "question",
      position: questionPosition,
      data: { question: "", answer: "" },
      width: QUESTION_NODE_WIDTH,
    },
    ...sources.map((source) => ({
      id: source.id,
      type: "source",
      position: questionPosition,
      data: { title: "", url: "" } satisfies SourceNodeData,
      width: SOURCE_NODE_WIDTH,
    })),
  ];
  const layoutEdges = [
    ...edges,
    ...sources.map((source, index) => ({
      id: `edge-${questionId}-${source.id}-${index}`,
      source: questionId,
      target: source.id,
    })),
  ];
  const { positions } = await layoutFlowWithElk({
    nodes: layoutNodes,
    edges: layoutEdges,
    direction: "RIGHT",
    useExistingPositions: true,
  });

  const rawPositions = sources.map((source, index) => {
    const position = positions[source.id];
    if (position) {
      return position;
    }
    return {
      x: questionPosition.x + SOURCE_NODE_WIDTH,
      y: questionPosition.y + index * SOURCE_NODE_HEIGHT,
    };
  });

  const placedNodes: FlowNode[] = [
    ...nodes,
    {
      id: questionId,
      type: "question",
      position: questionPosition,
      data: { question: "", answer: "" },
      width: QUESTION_NODE_WIDTH,
    },
  ];

  return rawPositions.map((position, index) => {
    const resolved = resolveColumnPosition({
      desired: position,
      nodes: placedNodes,
      size: { width: SOURCE_NODE_WIDTH, height: SOURCE_NODE_HEIGHT },
      stepX: 140,
      stepY: 90,
    });
    placedNodes.push({
      id: `__placed_${index}`,
      type: "source",
      position: resolved,
      data: { title: "", url: "" } satisfies SourceNodeData,
      width: SOURCE_NODE_WIDTH,
    });
    return resolved;
  });
};
