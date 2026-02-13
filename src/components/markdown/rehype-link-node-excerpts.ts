import type {
  Parent,
  Root,
  Element,
} from "hast";
import { findFlexibleRanges, mergeRanges } from "@/components/markdown/text-match";
import {
  collectTextNodes,
  localOverlapsForEntry,
  replaceEntryWithRanges,
} from "@/components/markdown/rehype-text-ranges";

export interface NodeExcerptRef {
  id: string;
  text: string;
}

const isDev = import.meta.env.DEV;

const inlineIgnoredParentTags = new Set([
  "button",
  "code",
  "mark",
  "pre",
]);

const ignoredParentTags = new Set([
  ...inlineIgnoredParentTags,
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
]);

const isParentNode = (value: unknown): value is Root | Parent | Element =>
  typeof value === "object" &&
  value !== null &&
  "children" in value &&
  Array.isArray((value as { children: unknown }).children);

const collectTableCells = (root: Root): Element[] => {
  const cells: Element[] = [];
  const stack: (Root | Parent | Element)[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isParentNode(current)) {
      continue;
    }
    for (const child of current.children) {
      if (child.type !== "element") {
        if (isParentNode(child)) {
          stack.push(child);
        }
        continue;
      }
      const tagName = child.tagName.toLowerCase();
      if (tagName === "td" || tagName === "th") {
        cells.push(child);
      }
      stack.push(child);
    }
  }
  return cells;
};

const applyRefToScope = (
  scope: Root | Parent | Element,
  ref: { id: string; text: string },
  scopeIgnoredParentTags: ReadonlySet<string>,
  options?: {
    focusable?: boolean;
  },
): number => {
  const scopeRoot: Root =
    scope.type === "root"
      ? scope
      : { type: "root", children: scope.children };
  const { entries, combinedText } = collectTextNodes(scopeRoot, {
    ignoredParentTags: scopeIgnoredParentTags,
    shouldSkipParent: (node: Root | Parent | Element) => hasNodeRefFlag(node),
  });
  if (entries.length === 0 || !combinedText) {
    return 0;
  }

  const ranges = mergeRanges(findFlexibleRanges(combinedText, ref.text));
  if (ranges.length === 0) {
    return 0;
  }

  let replacementCount = 0;
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    const overlaps = mergeRanges(localOverlapsForEntry(entry, ranges));
    if (overlaps.length === 0) {
      continue;
    }
    replaceEntryWithRanges(entry, overlaps, (text) => ({
      type: "element",
      tagName: "span",
      properties: {
        className: ["node-ref-link"],
        dataNodeRef: ref.id,
        ...(options?.focusable !== false
          ? {
              role: "button",
              tabIndex: 0,
            }
          : {}),
      },
      children: [{ type: "text", value: text }],
    }));
    replacementCount += overlaps.length;
  }
  return replacementCount;
};

const buildTableNeedles = (text: string): string[] => {
  const full = text.trim();
  if (!full) {
    return [];
  }
  const byPipe = full
    .split(/\r?\n/)
    .flatMap((line) => line.split("|"))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8);
  const deduped = new Set<string>([full, ...byPipe]);
  return Array.from(deduped);
};

const hasNodeRefFlag = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("properties" in value)) {
    return false;
  }
  const properties = (value as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) {
    return false;
  }
  return (
    "dataNodeRef" in properties ||
    "data-node-ref" in properties
  );
};

export function rehypeLinkNodeExcerpts(
  nodeExcerptRefs: NodeExcerptRef[],
  _focusedExcerpt?: string,
) {
  const refs = nodeExcerptRefs
    .map((item) => ({
      id: item.id,
      text: item.text.trim(),
    }))
    .filter(
      (item) => item.id.trim().length > 0 && item.text.length > 0,
    );

  if (refs.length === 0) {
    return () => undefined;
  }

  return (tree: Root | undefined) => {
    if (!tree) {
      return;
    }
    const tableCells = collectTableCells(tree);

    for (const ref of refs) {
      // Global matching excludes tables to prevent cross-cell matching artifacts.
      const globalReplacementCount = applyRefToScope(tree, ref, ignoredParentTags, {
        focusable: true,
      });
      const tableNeedles = buildTableNeedles(ref.text);
      // Table matching is scoped per cell to keep table layout stable.
      let tableReplacementCount = 0;
      let tableMatchedCells = 0;
      tableCells.forEach((cell) => {
        let cellReplacements = 0;
        tableNeedles.forEach((needle) => {
          cellReplacements += applyRefToScope(
            cell,
            { id: ref.id, text: needle },
            inlineIgnoredParentTags,
            { focusable: false },
          );
        });
        tableReplacementCount += cellReplacements;
        if (cellReplacements > 0) {
          tableMatchedCells += 1;
        }
      });
      if (isDev) {
        console.log("[markdown.nodeRefLink.match]", {
          refId: ref.id,
          refLength: ref.text.length,
          refPreview: ref.text.slice(0, 220),
          tableCellCount: tableCells.length,
          globalReplacementCount,
          tableReplacementCount,
          tableMatchedCells,
          tableNeedlesCount: tableNeedles.length,
          tableNeedlesPreview: tableNeedles.slice(0, 4),
        });
      }
    }
  };
}
