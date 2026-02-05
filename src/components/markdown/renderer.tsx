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

type TextRange = { start: number; end: number };

const collapseWhitespace = (input: string) => input.replace(/\s+/g, " ").trim();

const stripMarkdownSyntax = (input: string) => {
  let text = input;
  text = text.replace(/```[^\n]*\n?/g, "");
  text = text.replace(/```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^(\s*([-*+]|\d+[.)]))\s+/gm, "");
  return text;
};

const buildNeedleVariants = (input: string) => {
  const variants = new Set<string>();
  const trimmed = input.trim();
  if (trimmed) {
    variants.add(trimmed);
  }
  const stripped = stripMarkdownSyntax(trimmed);
  if (stripped) {
    variants.add(stripped);
    variants.add(collapseWhitespace(stripped));
  }
  return Array.from(variants).filter(Boolean);
};

const findExactRanges = (
  haystack: string,
  needle: string,
  caseInsensitive: boolean,
): TextRange[] => {
  if (!needle) {
    return [];
  }
  const source = caseInsensitive ? haystack.toLowerCase() : haystack;
  const target = caseInsensitive ? needle.toLowerCase() : needle;
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < source.length) {
    const matchIndex = source.indexOf(target, index);
    if (matchIndex === -1) {
      break;
    }
    ranges.push({ start: matchIndex, end: matchIndex + target.length });
    index = matchIndex + target.length;
  }
  return ranges;
};

const normalizeWithMap = (input: string) => {
  const map: number[] = [];
  let normalized = "";
  let sawContent = false;
  let inSpace = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (/\s/.test(char)) {
      if (!sawContent || inSpace) {
        continue;
      }
      normalized += " ";
      map.push(i);
      inSpace = true;
      continue;
    }
    sawContent = true;
    inSpace = false;
    normalized += char.toLowerCase();
    map.push(i);
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }
  return { normalized, map };
};

const normalizeText = (input: string) =>
  collapseWhitespace(input).toLowerCase();

const findNormalizedRanges = (
  haystack: string,
  needle: string,
): TextRange[] => {
  if (!needle) {
    return [];
  }
  const { normalized, map } = normalizeWithMap(haystack);
  const target = normalizeText(needle);
  if (!target) {
    return [];
  }
  if (target.length < 3) {
    return [];
  }
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < normalized.length) {
    const matchIndex = normalized.indexOf(target, index);
    if (matchIndex === -1) {
      break;
    }
    const start = map[matchIndex];
    const end = map[matchIndex + target.length - 1] + 1;
    ranges.push({ start, end });
    index = matchIndex + target.length;
  }
  return ranges;
};

const mergeRanges = (ranges: TextRange[]) => {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  let current = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    if (next.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, next.end) };
      continue;
    }
    merged.push(current);
    current = next;
  }
  merged.push(current);
  return merged;
};

const findFlexibleRanges = (haystack: string, needle: string): TextRange[] => {
  const variants = buildNeedleVariants(needle);
  for (const variant of variants) {
    const exact = findExactRanges(haystack, variant, false);
    if (exact.length) {
      return exact;
    }
  }
  for (const variant of variants) {
    const exact = findExactRanges(haystack, variant, true);
    if (exact.length) {
      return exact;
    }
  }
  for (const variant of variants) {
    const normalized = findNormalizedRanges(haystack, variant);
    if (normalized.length) {
      return normalized;
    }
  }
  return [];
};

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

        const ranges = mergeRanges(findFlexibleRanges(combined, needle));
        if (!ranges.length) {
          return;
        }

        ranges.forEach(({ start, end }) => {
          textNodes.forEach((item) => {
            if (end <= item.start || start >= item.end) {
              return;
            }
            const node = item.node;
            const nodeText = node.textContent ?? "";
            const sliceStart = Math.max(0, start - item.start);
            const sliceEnd = Math.min(nodeText.length, end - item.start);

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
        });
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
