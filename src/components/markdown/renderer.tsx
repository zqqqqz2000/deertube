import "katex/dist/katex.min.css";
import "@/assets/github-markdown.css";
import "@/assets/mdx-renderer.css";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Pluggable } from "unified";
import { MarkdownHooks } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypePrettyCode from "rehype-pretty-code";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";
import { mdxComponents } from "@/components/markdown/components/mdx-components";

interface MarkdownRendererProps {
  source: string;
  className?: string;
  highlightExcerpt?: string;
}

export const MarkdownRenderer = memo(
  ({ source, className, highlightExcerpt }: MarkdownRendererProps) => {
    const containerRef = useRef<HTMLElement | null>(null);
    const remarkPlugins = useMemo<Pluggable[]>(() => [remarkGfm, remarkMath], []);
    const rehypePlugins = useMemo<Pluggable[]>(() => {
      const plugins: Pluggable[] = [];
      plugins.push(rehypeKatex, [rehypePrettyCode, { theme: "vitesse-dark", keepBackground: false }]);
      return plugins;
    }, []);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const unwrapMarks = () => {
        const marks = container.querySelectorAll(
          'mark[data-highlight-excerpt="true"]',
        );
        marks.forEach((mark) => {
          const parent = mark.parentNode;
          if (!parent) {
            return;
          }
          parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
          parent.normalize();
        });
      };

      const shouldSkip = (node: Node) => {
        const parent = node.parentElement;
        if (!parent) {
          return false;
        }
        const tag = parent.tagName;
        return tag === "CODE" || tag === "PRE" || tag === "MARK";
      };

      const highlightText = (needle: string) => {
        const textNodes: { node: Text; start: number; end: number }[] = [];
        let cursor = 0;
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              if (shouldSkip(node)) {
                return NodeFilter.FILTER_REJECT;
              }
              if (!node.textContent || node.textContent.trim() === "") {
                return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_ACCEPT;
            },
          },
        );

        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const value = node.textContent ?? "";
          const start = cursor;
          const end = start + value.length;
          textNodes.push({ node, start, end });
          cursor = end;
        }

        const combined = textNodes.map((item) => item.node.textContent ?? "").join("");
        if (!combined || !needle) {
          return;
        }

        let searchIndex = 0;
        while (searchIndex < combined.length) {
          const matchIndex = combined.indexOf(needle, searchIndex);
          if (matchIndex === -1) {
            break;
          }
          const matchEnd = matchIndex + needle.length;

          textNodes.forEach((item) => {
            if (matchEnd <= item.start || matchIndex >= item.end) {
              return;
            }
            const node = item.node;
            const nodeText = node.textContent ?? "";
            const sliceStart = Math.max(0, matchIndex - item.start);
            const sliceEnd = Math.min(nodeText.length, matchEnd - item.start);

            if (sliceStart === 0 && sliceEnd === nodeText.length) {
              const mark = document.createElement("mark");
              mark.setAttribute("data-highlight-excerpt", "true");
              mark.className = "rounded bg-amber-300/30 px-1 text-amber-100";
              mark.textContent = nodeText;
              node.parentNode?.replaceChild(mark, node);
              return;
            }

            const before = nodeText.slice(0, sliceStart);
            const middle = nodeText.slice(sliceStart, sliceEnd);
            const after = nodeText.slice(sliceEnd);

            const fragment = document.createDocumentFragment();
            if (before) {
              fragment.appendChild(document.createTextNode(before));
            }
            if (middle) {
              const mark = document.createElement("mark");
              mark.setAttribute("data-highlight-excerpt", "true");
              mark.className = "rounded bg-amber-300/30 px-1 text-amber-100";
              mark.textContent = middle;
              fragment.appendChild(mark);
            }
            if (after) {
              fragment.appendChild(document.createTextNode(after));
            }

            node.parentNode?.replaceChild(fragment, node);
          });

          searchIndex = matchEnd;
        }
      };

      unwrapMarks();
      if (highlightExcerpt) {
        highlightText(highlightExcerpt);
      }
    }, [highlightExcerpt, source]);

    return (
      <article
        ref={containerRef}
        className={cn("markdown-body text-sm leading-relaxed", className)}
      >
        <MarkdownHooks
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={mdxComponents}
        >
          {source.trimStart()}
        </MarkdownHooks>
      </article>
    );
  },
);

MarkdownRenderer.displayName = "MarkdownRenderer";
