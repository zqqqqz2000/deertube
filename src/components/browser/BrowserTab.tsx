import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrowserViewBounds } from "@/types/browserview";
import { cn } from "@/lib/utils";

interface BrowserTabProps {
  tabId: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBoundsChange: (tabId: string, bounds: BrowserViewBounds) => void;
  onRequestBack: (tabId: string) => void;
  onRequestForward: (tabId: string) => void;
  onRequestReload: (tabId: string) => void;
  onRequestOpenExternal: (url: string) => void;
  onRequestNavigate: (tabId: string, url: string) => void;
}

export function BrowserTab({
  tabId,
  url,
  canGoBack,
  canGoForward,
  onBoundsChange,
  onRequestBack,
  onRequestForward,
  onRequestReload,
  onRequestOpenExternal,
  onRequestNavigate,
}: BrowserTabProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [address, setAddress] = useState(url);
  const [isEditing, setIsEditing] = useState(false);

  const emitBounds = useCallback(() => {
    const node = viewRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    onBoundsChange(tabId, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, [onBoundsChange, tabId]);

  useLayoutEffect(() => {
    emitBounds();
  }, [emitBounds, url]);

  useEffect(() => {
    if (!url || isEditing) {
      return;
    }
    setAddress(url);
  }, [isEditing, url]);

  useEffect(() => {
    const handle = () => {
      requestAnimationFrame(() => emitBounds());
    };
    const observer = new ResizeObserver(handle);
    if (viewRef.current) {
      observer.observe(viewRef.current);
    }
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("resize", handle);
      observer.disconnect();
    };
  }, [emitBounds]);

  const commitAddress = () => {
    const raw = address.trim();
    if (!raw) {
      return;
    }
    const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
    const nextUrl = hasProtocol ? raw : `https://${raw}`;
    if (nextUrl !== url) {
      onRequestNavigate(tabId, nextUrl);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/70 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitAddress();
                setIsEditing(false);
              }
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={() => {
              commitAddress();
              setIsEditing(false);
            }}
            placeholder="Enter URL"
            className="h-7 w-full rounded-md border border-border/60 bg-background/80 px-2 text-[11px] text-foreground shadow-inner shadow-black/10 focus:border-border focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground",
            )}
            onClick={() => onRequestBack(tabId)}
            disabled={!canGoBack}
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground",
            )}
            onClick={() => onRequestForward(tabId)}
            disabled={!canGoForward}
            title="Forward"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground",
            )}
            onClick={() => onRequestReload(tabId)}
            disabled={!url}
            title="Reload"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => onRequestOpenExternal(url)}
            disabled={!url}
            title="Open in browser"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div ref={viewRef} className="relative flex-1 bg-muted/20">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {url ? "Loading page..." : "Enter a URL to start"}
        </div>
      </div>
    </div>
  );
}
