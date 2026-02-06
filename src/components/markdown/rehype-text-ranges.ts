import type {
  Element,
  ElementContent,
  Parent,
  Root,
  Text,
} from "hast";
import type { TextRange } from "@/components/markdown/text-match";

export interface TextNodeEntry {
  node: Text;
  parent: Parent;
  index: number;
  start: number;
  end: number;
}

interface CollectTextNodesOptions {
  ignoredParentTags: ReadonlySet<string>;
  shouldSkipParent?: (node: Root | Parent | Element) => boolean;
}

const isParentNode = (value: unknown): value is Parent =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value as { type: unknown }).type !== "text" &&
  "children" in value &&
  Array.isArray((value as { children: unknown }).children);

export const collectTextNodes = (
  root: Root,
  options: CollectTextNodesOptions,
): { entries: TextNodeEntry[]; combinedText: string } => {
  const entries: TextNodeEntry[] = [];
  let cursor = 0;

  const walk = (node: Root | Parent | Element, parentTag: string | null) => {
    if (!isParentNode(node)) {
      return;
    }
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      if (child.type === "element") {
        const tagName = child.tagName.toLowerCase();
        if (options.ignoredParentTags.has(tagName)) {
          continue;
        }
        walk(child, tagName);
        continue;
      }
      if (child.type !== "text") {
        if (isParentNode(child)) {
          walk(child, parentTag);
        }
        continue;
      }
      if (parentTag && options.ignoredParentTags.has(parentTag)) {
        continue;
      }
      if (options.shouldSkipParent?.(node)) {
        continue;
      }
      const value = child.value ?? "";
      if (value.length === 0) {
        continue;
      }
      entries.push({
        node: child,
        parent: node,
        index,
        start: cursor,
        end: cursor + value.length,
      });
      cursor += value.length;
    }
  };

  walk(root, null);
  const combinedText = entries.map((entry) => entry.node.value ?? "").join("");
  return { entries, combinedText };
};

const buildReplacementNodes = (
  text: string,
  overlaps: TextRange[],
  wrapMatch: (matchedText: string) => ElementContent,
): ElementContent[] => {
  if (overlaps.length === 0) {
    return [{ type: "text", value: text }];
  }
  const pieces: ElementContent[] = [];
  let cursor = 0;
  overlaps.forEach((overlap) => {
    if (overlap.start > cursor) {
      pieces.push({ type: "text", value: text.slice(cursor, overlap.start) });
    }
    pieces.push(wrapMatch(text.slice(overlap.start, overlap.end)));
    cursor = overlap.end;
  });
  if (cursor < text.length) {
    pieces.push({ type: "text", value: text.slice(cursor) });
  }
  return pieces;
};

export const localOverlapsForEntry = (
  entry: TextNodeEntry,
  ranges: TextRange[],
): TextRange[] =>
  ranges
    .filter((range) => range.end > entry.start && range.start < entry.end)
    .map((range) => {
      const localStart = Math.max(0, range.start - entry.start);
      const localEnd = Math.min(entry.end - entry.start, range.end - entry.start);
      return { start: localStart, end: localEnd };
    })
    .filter((range) => range.end > range.start);

export const replaceEntryWithRanges = (
  entry: TextNodeEntry,
  overlaps: TextRange[],
  wrapMatch: (matchedText: string) => ElementContent,
) => {
  const textValue = entry.node.value ?? "";
  if (!textValue) {
    return;
  }
  const replacement = buildReplacementNodes(textValue, overlaps, wrapMatch);
  entry.parent.children.splice(entry.index, 1, ...replacement);
};
