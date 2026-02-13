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
import { getHighlightExcerptKey } from "@/components/markdown/highlight-excerpt-key";

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

const excludeLineBreaksFromRanges = (
  text: string,
  ranges: { start: number; end: number }[],
): { start: number; end: number }[] => {
  const segments: { start: number; end: number }[] = [];
  ranges.forEach((range) => {
    let segmentStart = -1;
    for (let index = range.start; index < range.end; index += 1) {
      const char = text[index];
      if (char === "\n" || char === "\r") {
        if (segmentStart >= 0) {
          segments.push({ start: segmentStart, end: index });
          segmentStart = -1;
        }
        continue;
      }
      if (segmentStart < 0) {
        segmentStart = index;
      }
    }
    if (segmentStart >= 0) {
      segments.push({ start: segmentStart, end: range.end });
    }
  });
  return segments.filter((segment) => segment.end > segment.start);
};

export function rehypeHighlightExcerpt(excerpt: string) {
  const needle = excerpt.trim();
  if (!needle) {
    return () => undefined;
  }
  const highlightKey = getHighlightExcerptKey(needle);

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
      const overlaps = mergeRanges(
        excludeLineBreaksFromRanges(
          entry.node.value ?? "",
          localOverlapsForEntry(entry, ranges),
        ),
      );
      if (overlaps.length === 0) {
        continue;
      }
      replaceEntryWithRanges(entry, overlaps, (text) => ({
        type: "element",
        tagName: "mark",
        properties: {
          className: highlightClasses,
          dataHighlightExcerpt: "true",
          dataHighlightExcerptKey: highlightKey,
        },
        children: [{ type: "text", value: text }],
      }));
    }
  };
}
