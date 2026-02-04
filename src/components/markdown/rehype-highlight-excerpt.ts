import type { Element, ElementContent, Parent, Root, Text } from "hast";
import { SKIP, visit } from "unist-util-visit";

const highlightClasses = [
  "rounded",
  "bg-sky-400/25",
  "px-1",
  "text-sky-50",
];

const ignoredParents = new Set(["code", "pre"]);

export function rehypeHighlightExcerpt(excerpt: string) {
  const needle = excerpt.trim();
  if (!needle) {
    return () => undefined;
  }

  return (tree: Root | undefined) => {
    if (!tree) {
      return;
    }
    visit(tree, "text", (node: Text, index, parent: Parent | null) => {
      if (!parent || typeof index !== "number") {
        return;
      }
      if (
        parent.type === "element" &&
        ignoredParents.has((parent as Element).tagName)
      ) {
        return;
      }
      if (!node.value.includes(needle)) {
        return;
      }

      const segments = node.value.split(needle);
      if (segments.length <= 1) {
        return;
      }

      const replacement: ElementContent[] = [];

      segments.forEach((segment, segmentIndex) => {
        if (segment) {
          replacement.push({ type: "text", value: segment });
        }
        if (segmentIndex < segments.length - 1) {
          replacement.push({
            type: "element",
            tagName: "mark",
            properties: { className: highlightClasses },
            children: [{ type: "text", value: needle }],
          });
        }
      });

      parent.children.splice(index, 1, ...replacement);
      return SKIP;
    });
  };
}
