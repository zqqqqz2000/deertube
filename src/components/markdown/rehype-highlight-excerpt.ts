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

const highlightClasses = [
  "rounded",
  "bg-sky-400/25",
  "px-1",
  "text-sky-50",
];

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

export function rehypeHighlightExcerpt(excerpt: string) {
  const needle = excerpt.trim();
  if (!needle) {
    return () => undefined;
  }

  return (tree: Root | undefined) => {
    if (!tree) {
      return;
    }

    const { entries, combinedText } = collectTextNodes(tree, {
      ignoredParentTags,
      shouldSkipParent: (node: Root | Parent | Element) => hasNodeRefFlag(node),
    });
    if (entries.length === 0 || !combinedText) {
      return;
    }

    const ranges = mergeRanges(findFlexibleRanges(combinedText, needle));
    if (ranges.length === 0) {
      return;
    }

    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      const overlaps = mergeRanges(localOverlapsForEntry(entry, ranges));
      if (overlaps.length === 0) {
        continue;
      }
      replaceEntryWithRanges(entry, overlaps, (text) => ({
        type: "element",
        tagName: "mark",
        properties: {
          className: highlightClasses,
          dataHighlightExcerpt: "true",
        },
        children: [{ type: "text", value: text }],
      }));
    }
  };
}
