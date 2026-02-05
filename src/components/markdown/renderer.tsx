import "katex/dist/katex.min.css";
import "@/assets/github-markdown.css";
import "@/assets/mdx-renderer.css";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
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
  onNodeLinkClick?: (nodeId: string) => void;
  resolveNodeLabel?: (nodeId: string) => string | undefined;
  nodeExcerptRefs?: { id: string; text: string }[];
}

export const MarkdownRenderer = memo(
  ({
    source,
    className,
    highlightExcerpt,
    onNodeLinkClick,
    resolveNodeLabel,
    nodeExcerptRefs = [],
  }: MarkdownRendererProps) => {
    const containerRef = useRef<HTMLElement | null>(null);
    const remarkPlugins = useMemo<Pluggable[]>(() => [remarkGfm, remarkMath], []);
    const rehypePlugins = useMemo<Pluggable[]>(() => {
      const plugins: Pluggable[] = [];
      plugins.push(rehypeKatex, [rehypePrettyCode, { theme: "vitesse-dark", keepBackground: false }]);
      return plugins;
    }, []);
    const urlTransform = useCallback((href: string) => href, []);
    const resolvedSource = useMemo(() => {
      if (!source) {
        return source;
      }
      return source.replace(
        /\[\[node:([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_match, nodeId, label) => {
          const nodeIdText = String(nodeId);
          const fallback =
            (resolveNodeLabel ? resolveNodeLabel(nodeIdText) : undefined) ??
            `Node ${nodeIdText.slice(0, 6)}`;
          const labelText =
            label !== undefined && label !== null ? String(label).trim() : "";
          const text = labelText || fallback;
          return `[${text}](node:${nodeIdText})`;
        },
      );
    }, [resolveNodeLabel, source]);
    const components = useMemo(() => {
      const parseNodeHref = (href?: string | null) => {
        if (!href) {
          return null;
        }
        const trimmed = href.trim();
        if (trimmed.startsWith("node://")) {
          return trimmed.slice("node://".length);
        }
        if (trimmed.startsWith("node:")) {
          return trimmed.slice("node:".length);
        }
        if (trimmed.startsWith("deertube://node/")) {
          return trimmed.slice("deertube://node/".length);
        }
        return null;
      };
      const flattenText = (children: ReactNode): string => {
        if (typeof children === "string") {
          return children;
        }
        if (Array.isArray(children)) {
          return children
            .map((child) => flattenText(child as ReactNode))
            .join("");
        }
        if (children && typeof children === "object" && "props" in children) {
          const childProps = (children as { props?: { children?: ReactNode } })
            .props;
          return childProps?.children
            ? flattenText(childProps.children as ReactNode)
            : "";
        }
        return "";
      };
      return {
        ...mdxComponents,
        a: (
          props: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown },
        ) => {
          const nodeProp = props.node;
          const rawHref =
            props.href ??
            (nodeProp && typeof nodeProp === "object" && "url" in nodeProp
              ? String((nodeProp as { url?: string }).url ?? "")
              : undefined) ??
            (nodeProp &&
            typeof nodeProp === "object" &&
            "properties" in nodeProp &&
            (nodeProp as { properties?: { href?: string } }).properties?.href
              ? String(
                  (nodeProp as { properties?: { href?: string } }).properties?.href,
                )
              : undefined);
          const nodeId = parseNodeHref(rawHref);
          if (nodeId) {
            const labelText = flattenText(props.children);
            const label =
              (labelText.length > 0 ? labelText : undefined) ??
              (resolveNodeLabel ? resolveNodeLabel(nodeId) : undefined) ??
              `Node ${nodeId.slice(0, 6)}`;
            return (
              <button
                type="button"
                onClick={() => onNodeLinkClick?.(nodeId)}
                className="inline text-sky-200 underline decoration-sky-300/80 underline-offset-4 transition hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                title={`Focus node ${label}`}
                disabled={!onNodeLinkClick}
              >
                {label}
              </button>
            );
          }
          const { node: _node, ...restProps } = props;
          return (
            <a
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-300 underline-offset-4 hover:underline"
              {...restProps}
            />
          );
        },
      };
    }, [onNodeLinkClick, resolveNodeLabel]);

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
      const unwrapNodeRefs = () => {
        const refs = container.querySelectorAll('span[data-node-ref]');
        refs.forEach((ref) => {
          const parent = ref.parentNode;
          if (!parent) {
            return;
          }
          parent.replaceChild(document.createTextNode(ref.textContent ?? ""), ref);
          parent.normalize();
        });
      };

      const shouldSkip = (node: Node) => {
        const parent = node.parentElement;
        if (!parent) {
          return false;
        }
        const tag = parent.tagName;
        return (
          tag === "CODE" ||
          tag === "PRE" ||
          tag === "MARK" ||
          tag === "BUTTON" ||
          parent.hasAttribute("data-node-ref")
        );
      };

      const wrapText = (
        needle: string,
        wrapper: (text: string) => HTMLElement,
      ) => {
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
              const wrapped = wrapper(nodeText);
              node.parentNode?.replaceChild(wrapped, node);
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
              fragment.appendChild(wrapper(middle));
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
      unwrapNodeRefs();
      if (highlightExcerpt) {
        wrapText(highlightExcerpt, (text) => {
          const mark = document.createElement("mark");
          mark.setAttribute("data-highlight-excerpt", "true");
          mark.className = "rounded bg-sky-400/25 px-1 text-sky-50";
          mark.textContent = text;
          return mark;
        });
      }
      const focusNeedle = highlightExcerpt?.trim();
      const refItems = nodeExcerptRefs
        .map((item) => ({ ...item, text: item.text.trim() }))
        .filter((item) => item.text.length > 0 && item.text !== focusNeedle);
      refItems.forEach((item) => {
        wrapText(item.text, (text) => {
          const span = document.createElement("span");
          span.setAttribute("data-node-ref", item.id);
          span.className = "node-ref-link";
          span.textContent = text;
          return span;
        });
      });
    }, [highlightExcerpt, source, nodeExcerptRefs]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !onNodeLinkClick) {
        return;
      }

      const handleClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        const ref = target.closest<HTMLElement>("[data-node-ref]");
        if (!ref) {
          return;
        }
        const nodeId = ref.dataset.nodeRef;
        if (!nodeId) {
          return;
        }
        onNodeLinkClick(nodeId);
      };

      container.addEventListener("click", handleClick);
      return () => {
        container.removeEventListener("click", handleClick);
      };
    }, [onNodeLinkClick, nodeExcerptRefs]);

    return (
      <article
        ref={containerRef}
        className={cn("markdown-body text-sm leading-relaxed", className)}
      >
        <MarkdownHooks
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
          components={components}
        >
          {resolvedSource.trimStart()}
        </MarkdownHooks>
      </article>
    );
  },
);

MarkdownRenderer.displayName = "MarkdownRenderer";
