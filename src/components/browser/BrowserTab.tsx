import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  BrowserPageValidationRecord,
  BrowserValidationStatus,
  BrowserViewBounds,
} from "@/types/browserview";
import { cn } from "@/lib/utils";

const formatAccuracyLabel = (
  accuracy: BrowserPageValidationRecord["accuracy"],
): string | null => {
  if (!accuracy) {
    return null;
  }
  if (accuracy === "high") {
    return "High";
  }
  if (accuracy === "medium") {
    return "Medium";
  }
  if (accuracy === "low") {
    return "Low";
  }
  if (accuracy === "conflicting") {
    return "Conflicting";
  }
  return "Insufficient";
};

const getAccuracyTextClass = (
  accuracy: BrowserPageValidationRecord["accuracy"],
): string => {
  if (accuracy === "high") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "text-amber-700 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "text-orange-700 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "text-red-700 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "text-slate-700 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

const getValidationButtonToneClass = ({
  status,
  accuracy,
  hasError,
}: {
  status?: BrowserValidationStatus;
  accuracy?: BrowserPageValidationRecord["accuracy"];
  hasError: boolean;
}): string => {
  if (status === "running") {
    return "border-sky-400/50 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300";
  }
  if (hasError || status === "failed") {
    return "border-red-400/50 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300";
  }
  if (accuracy === "high") {
    return "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "border-amber-400/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "border-orange-400/50 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "border-red-400/50 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "border-slate-400/50 bg-slate-500/10 text-slate-700 hover:bg-slate-500/20 dark:text-slate-300";
  }
  return "border-border/70 bg-card/70 text-muted-foreground hover:bg-accent/50";
};

interface BrowserTabProps {
  tabId: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  validation?: BrowserPageValidationRecord;
  validationStatus?: BrowserValidationStatus;
  validationError?: string;
  onBoundsChange: (tabId: string, bounds: BrowserViewBounds) => void;
  onRequestBack: (tabId: string) => void;
  onRequestForward: (tabId: string) => void;
  onRequestReload: (tabId: string) => void;
  onRequestValidate: (tabId: string) => void;
  onRequestOpenCdp: (tabId: string, url: string) => void;
  onRequestOpenExternal: (url: string) => void;
  onRequestNavigate: (tabId: string, url: string) => void;
}

export function BrowserTab({
  tabId,
  url,
  canGoBack,
  canGoForward,
  validation,
  validationStatus,
  validationError,
  onBoundsChange,
  onRequestBack,
  onRequestForward,
  onRequestReload,
  onRequestValidate,
  onRequestOpenCdp,
  onRequestOpenExternal,
  onRequestNavigate,
}: BrowserTabProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const validationPopoverTimerRef = useRef<number | null>(null);
  const [address, setAddress] = useState(url);
  const [isEditing, setIsEditing] = useState(false);
  const [validationPopoverOpen, setValidationPopoverOpen] = useState(false);
  const hasValidationPopoverContent =
    validationStatus === "running" || Boolean(validationError) || Boolean(validation);
  const accuracyLabel = formatAccuracyLabel(validation?.accuracy);
  const checkedAtLabel = useMemo(() => {
    if (!validation?.checkedAt) {
      return null;
    }
    const timestamp = Date.parse(validation.checkedAt);
    if (!Number.isFinite(timestamp)) {
      return validation.checkedAt;
    }
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  }, [validation?.checkedAt]);
  const validateButtonToneClass = getValidationButtonToneClass({
    status: validationStatus,
    accuracy: validation?.accuracy,
    hasError: Boolean(validationError),
  });
  const clearValidationPopoverTimer = useCallback(() => {
    if (validationPopoverTimerRef.current !== null) {
      window.clearTimeout(validationPopoverTimerRef.current);
      validationPopoverTimerRef.current = null;
    }
  }, []);
  const openValidationPopover = useCallback(() => {
    if (!hasValidationPopoverContent) {
      return;
    }
    clearValidationPopoverTimer();
    setValidationPopoverOpen(true);
  }, [clearValidationPopoverTimer, hasValidationPopoverContent]);
  const scheduleCloseValidationPopover = useCallback(() => {
    clearValidationPopoverTimer();
    validationPopoverTimerRef.current = window.setTimeout(() => {
      validationPopoverTimerRef.current = null;
      setValidationPopoverOpen(false);
    }, 140);
  }, [clearValidationPopoverTimer]);

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
    setValidationPopoverOpen(false);
    clearValidationPopoverTimer();
  }, [clearValidationPopoverTimer, url]);

  useEffect(() => {
    return () => {
      clearValidationPopoverTimer();
    };
  }, [clearValidationPopoverTimer]);

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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => onRequestOpenCdp(tabId, url)}
            disabled={!url}
            title="Open in CDP browser"
          >
            CDP
          </Button>
          <Popover
            open={validationPopoverOpen && hasValidationPopoverContent}
            onOpenChange={setValidationPopoverOpen}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5 px-2 text-[11px] font-medium",
                  validateButtonToneClass,
                )}
                onClick={() => {
                  if (validationStatus === "running") {
                    return;
                  }
                  onRequestValidate(tabId);
                }}
                disabled={!url}
                title="Validate page content"
                onMouseEnter={() => {
                  openValidationPopover();
                }}
                onMouseLeave={() => {
                  scheduleCloseValidationPopover();
                }}
              >
                {validationStatus === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : validationStatus === "failed" || validationError ? (
                  <AlertCircle className="h-3.5 w-3.5" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Validate
              </Button>
            </PopoverTrigger>
            {hasValidationPopoverContent ? (
              <PopoverContent
                align="end"
                side="bottom"
                className="w-[360px] p-3"
                onMouseEnter={() => {
                  openValidationPopover();
                }}
                onMouseLeave={() => {
                  scheduleCloseValidationPopover();
                }}
              >
                {validationStatus === "running" ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Validating current page...
                  </div>
                ) : validationError ? (
                  <div className="rounded border border-red-400/45 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                    {validationError}
                  </div>
                ) : validation ? (
                  <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {validation.referenceTitle ??
                        validation.title ??
                        "Validation Result"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {validation.referenceUrl ?? validation.url}
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      Lines {validation.startLine}-{validation.endLine}
                    </div>
                    {checkedAtLabel ? (
                      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        Checked {checkedAtLabel}
                      </div>
                    ) : null}
                    {accuracyLabel ? (
                      <div
                        className={cn(
                          "text-[10px] uppercase tracking-[0.12em]",
                          getAccuracyTextClass(validation.accuracy),
                        )}
                      >
                        Accuracy {accuracyLabel}
                      </div>
                    ) : null}
                    {validation.issueReason ? (
                      <div className="rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                        Why wrong: {validation.issueReason}
                      </div>
                    ) : null}
                    {validation.correctFact ? (
                      <div className="rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                        Correct fact: {validation.correctFact}
                      </div>
                    ) : null}
                    {validation.validationRefContent ? (
                      <div className="rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px] leading-relaxed text-foreground/90">
                        {validation.validationRefContent}
                      </div>
                    ) : null}
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                      {validation.text}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No validation result yet.
                  </div>
                )}
              </PopoverContent>
            ) : null}
          </Popover>
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
