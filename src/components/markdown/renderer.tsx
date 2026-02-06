import "katex/dist/katex.min.css";
import "@/assets/github-markdown.css";
import "@/assets/mdx-renderer.css";
import { memo, useCallback, useMemo } from "react";
import { isValidElement } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Pluggable } from "unified";
import { MarkdownHooks } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypePrettyCode from "rehype-pretty-code";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";
import { mdxComponents } from "@/components/markdown/components/mdx-components";
import { rehypeHighlightExcerpt } from "@/components/markdown/rehype-highlight-excerpt";
import { rehypeLinkNodeExcerpts } from "@/components/markdown/rehype-link-node-excerpts";

interface MarkdownRendererProps {
  source: string;
  className?: string;
  highlightExcerpt?: string;
  onNodeLinkClick?: (nodeId: string) => void;
  onReferenceClick?: (url: string, label?: string) => void;
  resolveNodeLabel?: (nodeId: string) => string | undefined;
  nodeExcerptRefs?: { id: string; text: string }[];
}

export const MarkdownRenderer = memo(
  ({
    source,
    className,
    highlightExcerpt,
    onNodeLinkClick,
    onReferenceClick,
    resolveNodeLabel,
    nodeExcerptRefs = [],
  }: MarkdownRendererProps) => {
    const remarkPlugins = useMemo<Pluggable[]>(() => [remarkGfm, remarkMath], []);
    const rehypePlugins = useMemo<Pluggable[]>(() => {
      const plugins: Pluggable[] = [];
      plugins.push(rehypeKatex, [
        rehypePrettyCode,
        { theme: "vitesse-dark", keepBackground: false },
      ]);
      const excerpt = highlightExcerpt?.trim();
      if (excerpt) {
        plugins.push(() => rehypeHighlightExcerpt(excerpt));
      }
      if (nodeExcerptRefs.length > 0) {
        plugins.push(() => rehypeLinkNodeExcerpts(nodeExcerptRefs, excerpt));
      }
      return plugins;
    }, [highlightExcerpt, nodeExcerptRefs]);
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

      const normalizeHref = (href: unknown): string | null => {
        if (typeof href === "string") {
          const trimmed = href.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (href instanceof URL) {
          return href.toString();
        }
        if (href === null || href === undefined) {
          return null;
        }
        try {
          const casted = String(href).trim();
          return casted.length > 0 ? casted : null;
        } catch {
          return null;
        }
      };

      const isHttpUrl = (href?: string | null) => {
        if (!href) {
          return false;
        }
        try {
          const parsed = new URL(href);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          return false;
        }
      };

      const isDeertubeUrl = (href?: string | null) => {
        if (!href) {
          return false;
        }
        if (href.toLowerCase().startsWith("deertube://")) {
          return true;
        }
        try {
          const parsed = new URL(href);
          return parsed.protocol === "deertube:";
        } catch {
          return false;
        }
      };

      const flattenText = (children: ReactNode): string => {
        const stack: ReactNode[] = [children];
        const fragments: string[] = [];
        let guard = 0;
        while (stack.length > 0 && guard < 6000) {
          guard += 1;
          const current = stack.pop();
          if (typeof current === "string" || typeof current === "number") {
            fragments.push(String(current));
            continue;
          }
          if (Array.isArray(current)) {
            for (let index = current.length - 1; index >= 0; index -= 1) {
              stack.push(current[index] as ReactNode);
            }
            continue;
          }
          if (isValidElement<{ children?: ReactNode }>(current)) {
            const child = current.props?.children;
            if (child !== current) {
              stack.push(child);
            }
          }
        }
        return fragments.join("");
      };

      const markdownLinkClassName = "markdown-link";
      const nodeLinkClassName = "markdown-link markdown-node-link";

      return {
        ...mdxComponents,
        a: (
          props: AnchorHTMLAttributes<HTMLAnchorElement> & {
            node?: { url?: string; properties?: { href?: string } };
          },
        ) => {
          const nodeProp = props.node;
          const { node: _node, children, ...restProps } = props;
          const rawHref =
            props.href ??
            (nodeProp && typeof nodeProp === "object" && "url" in nodeProp
              ? String(nodeProp.url ?? "")
              : undefined) ??
            (nodeProp &&
            typeof nodeProp === "object" &&
            "properties" in nodeProp &&
            nodeProp.properties?.href
              ? String(nodeProp.properties?.href)
              : undefined);
          const normalizedHref = normalizeHref(rawHref);
          const nodeId = parseNodeHref(normalizedHref);

          if (nodeId) {
            const labelText = flattenText(children);
            const label =
              (labelText.length > 0 ? labelText : undefined) ??
              (resolveNodeLabel ? resolveNodeLabel(nodeId) : undefined) ??
              `Node ${nodeId.slice(0, 6)}`;
            return (
              <button
                type="button"
                onClick={() => onNodeLinkClick?.(nodeId)}
                className={nodeLinkClassName}
                title={`Focus node ${label}`}
                disabled={!onNodeLinkClick}
              >
                {label}
              </button>
            );
          }

          if ((isHttpUrl(normalizedHref) || isDeertubeUrl(normalizedHref)) && onReferenceClick) {
            const labelText = flattenText(children);
            return (
              <a
                {...restProps}
                href={normalizedHref ?? undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (!normalizedHref) {
                    return;
                  }
                  onReferenceClick(normalizedHref, labelText);
                }}
                className={markdownLinkClassName}
                title={normalizedHref ?? undefined}
              >
                {children}
              </a>
            );
          }

          if (isDeertubeUrl(normalizedHref)) {
            return <span className={markdownLinkClassName}>{children}</span>;
          }

          return (
            <a
              {...restProps}
              target="_blank"
              rel="noopener noreferrer"
              className={markdownLinkClassName}
            >
              {children}
            </a>
          );
        },
      };
    }, [onNodeLinkClick, onReferenceClick, resolveNodeLabel]);

    const handleArticleClick = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        if (!onNodeLinkClick) {
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const ref = target.closest<HTMLElement>("[data-node-ref]");
        const nodeId = ref?.dataset.nodeRef;
        if (!nodeId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onNodeLinkClick(nodeId);
      },
      [onNodeLinkClick],
    );

    const handleArticleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (!onNodeLinkClick) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const ref = target.closest<HTMLElement>("[data-node-ref]");
        const nodeId = ref?.dataset.nodeRef;
        if (!nodeId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onNodeLinkClick(nodeId);
      },
      [onNodeLinkClick],
    );

    return (
      <article
        className={cn("markdown-body text-sm leading-relaxed", className)}
        onClick={handleArticleClick}
        onKeyDown={handleArticleKeyDown}
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
