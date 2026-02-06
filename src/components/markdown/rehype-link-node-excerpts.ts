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

const ignoredParentTags = new Set(["code", "pre", "mark", "button"]);

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
  focusedExcerpt?: string,
) {
  const focusNeedle = focusedExcerpt?.trim() ?? "";
  const refs = nodeExcerptRefs
    .map((item) => ({
      id: item.id,
      text: item.text.trim(),
    }))
    .filter(
      (item) => item.id.trim().length > 0 && item.text.length > 0 && item.text !== focusNeedle,
    );

  if (refs.length === 0) {
    return () => undefined;
  }

  return (tree: Root | undefined) => {
    if (!tree) {
      return;
    }

    for (const ref of refs) {
      const { entries, combinedText } = collectTextNodes(tree, {
        ignoredParentTags,
        shouldSkipParent: (node: Root | Parent | Element) => hasNodeRefFlag(node),
      });
      if (entries.length === 0 || !combinedText) {
        continue;
      }

      const ranges = mergeRanges(findFlexibleRanges(combinedText, ref.text));
      if (ranges.length === 0) {
        continue;
      }

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
            role: "button",
            tabIndex: 0,
          },
          children: [{ type: "text", value: text }],
        }));
      }
    }
  };
}
