import ELK from "elkjs/lib/elk.bundled";

import type {
  ElkExtendedEdge,
  LayoutOptions,
  ElkNode,
} from "elkjs/lib/elk-api";
import type { FlowNode } from "../types/flow";

export const QUESTION_NODE_WIDTH = 360;
export const QUESTION_NODE_HEIGHT = 190;
export const SOURCE_NODE_WIDTH = 300;
export const SOURCE_NODE_HEIGHT = 170;
export const QUESTION_FALLBACK_OFFSET_X = 360;
export const SOURCE_FALLBACK_OFFSET_X = 420;
export const SOURCE_FALLBACK_SPACING_Y = 170;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const elk = new ELK();

const baseLayoutOptions: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.nodeNode": "70",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
};

export const getNodeSize = (node: FlowNode | null) => {
  if (node?.type === "source") {
    return {
      width: node.width ?? SOURCE_NODE_WIDTH,
      height: SOURCE_NODE_HEIGHT,
    };
  }
  return {
    width: node?.width ?? QUESTION_NODE_WIDTH,
    height: QUESTION_NODE_HEIGHT,
  };
};

const toBounds = (point: Point, size: Size, padding = 24): Bounds => ({
  left: point.x - padding,
  right: point.x + size.width + padding,
  top: point.y - padding,
  bottom: point.y + size.height + padding,
});

const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const collides = (point: Point, size: Size, nodes: FlowNode[]): boolean => {
  const target = toBounds(point, size);
  return nodes.some((node) => {
    const nodeBounds = toBounds(node.position, getNodeSize(node));
    return boundsOverlap(target, nodeBounds);
  });
};

const rightBiasedCandidates = (
  base: Point,
  stepX: number,
  stepY: number,
  rings: number,
): Point[] => {
  const candidates: Point[] = [base];
  for (let ring = 1; ring <= rings; ring += 1) {
    const x = base.x + stepX * ring;
    candidates.push({ x, y: base.y });
    for (let v = 1; v <= ring; v += 1) {
      const y = stepY * v;
      candidates.push({ x, y: base.y + y });
      candidates.push({ x, y: base.y - y });
    }
  }
  return candidates;
};

export const resolveRightBiasedPosition = ({
  desired,
  nodes,
  size,
  stepX = 90,
  stepY = 60,
  rings = 10,
}: {
  desired: Point;
  nodes: FlowNode[];
  size: Size;
  stepX?: number;
  stepY?: number;
  rings?: number;
}): Point => {
  const candidates = rightBiasedCandidates(desired, stepX, stepY, rings);
  for (const candidate of candidates) {
    if (!collides(candidate, size, nodes)) {
      return candidate;
    }
  }
  return desired;
};

const nodeById = (layout: ElkNode, id: string): ElkNode | undefined =>
  layout.children?.find((child) => child.id === id);

const applyDelta = (point: Point, delta: Point): Point => ({
  x: point.x + delta.x,
  y: point.y + delta.y,
});

const layoutGraph = async (graph: ElkNode): Promise<ElkNode | null> => {
  try {
    return await elk.layout(graph);
  } catch {
    return null;
  }
};

export const layoutQuestionWithElk = async ({
  parent,
  parentPosition,
  questionId,
}: {
  parent: FlowNode | null;
  parentPosition: Point;
  questionId: string;
}): Promise<Point> => {
  const parentSize = getNodeSize(parent);
  const questionSize = {
    width: QUESTION_NODE_WIDTH,
    height: QUESTION_NODE_HEIGHT,
  };

  const graph: ElkNode = {
    id: "root",
    layoutOptions: baseLayoutOptions,
    children: [
      {
        id: parent?.id ?? "parent",
        width: parentSize.width,
        height: parentSize.height,
      },
      {
        id: questionId,
        width: questionSize.width,
        height: questionSize.height,
      },
    ],
    edges: [
      {
        id: "edge-parent-question",
        sources: [parent?.id ?? "parent"],
        targets: [questionId],
      },
    ],
  };

  const layout = await layoutGraph(graph);
  if (!layout) {
    return {
      x: parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: parentPosition.y,
    };
  }

  const layoutParent = nodeById(layout, parent?.id ?? "parent");
  const layoutQuestion = nodeById(layout, questionId);
  if (!layoutParent || !layoutQuestion) {
    return {
      x: parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: parentPosition.y,
    };
  }

  const delta = {
    x: parentPosition.x - (layoutParent.x ?? 0),
    y: parentPosition.y - (layoutParent.y ?? 0),
  };

  return applyDelta(
    {
      x: layoutQuestion.x ?? parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: layoutQuestion.y ?? parentPosition.y,
    },
    delta,
  );
};

export const layoutSourcesWithElk = async ({
  questionPosition,
  questionId,
  sourceIds,
}: {
  questionPosition: Point;
  questionId: string;
  sourceIds: string[];
}): Promise<Point[]> => {
  if (sourceIds.length === 0) {
    return [];
  }

  const children: ElkNode[] = [
    {
      id: questionId,
      width: QUESTION_NODE_WIDTH,
      height: QUESTION_NODE_HEIGHT,
    },
    ...sourceIds.map((id) => ({
      id,
      width: SOURCE_NODE_WIDTH,
      height: SOURCE_NODE_HEIGHT,
    })),
  ];

  const edges: ElkExtendedEdge[] = sourceIds.map((id, index) => ({
    id: `edge-${questionId}-${id}-${index}`,
    sources: [questionId],
    targets: [id],
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: baseLayoutOptions,
    children,
    edges,
  };

  const layout = await layoutGraph(graph);
  if (!layout) {
    return sourceIds.map((_, index) => ({
      x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
      y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
    }));
  }

  const layoutQuestion = nodeById(layout, questionId);
  if (!layoutQuestion) {
    return sourceIds.map((_, index) => ({
      x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
      y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
    }));
  }

  const delta = {
    x: questionPosition.x - (layoutQuestion.x ?? 0),
    y: questionPosition.y - (layoutQuestion.y ?? 0),
  };

  return sourceIds.map((id, index) => {
    const node = nodeById(layout, id);
    if (!node) {
      return {
        x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
        y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
      };
    }
    return applyDelta(
      {
        x: node.x ?? questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
        y: node.y ?? questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
      },
      delta,
    );
  });
};
