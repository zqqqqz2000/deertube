import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface FlowPanelInputProps {
  visible: boolean;
  left: number;
  top: number;
  width?: number;
  zoom?: number;
  prompt: string;
  busy: boolean;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onFocusZoom?: (focusInput: () => void) => void;
}

export default function FlowPanelInput({
  visible,
  left,
  top,
  width,
  zoom = 1,
  prompt,
  busy,
  onPromptChange,
  onSend,
  onFocusZoom,
}: FlowPanelInputProps) {
  const isMicro = zoom <= 0.55;
  const isCompact = !isMicro && zoom <= 0.85;
  const minWidth = isMicro ? 120 : isCompact ? 160 : 200;
  const resolvedWidth = width ? Math.max(width, minWidth) : minWidth;
  const placeholder = isMicro
    ? "Ask..."
    : isCompact
      ? "Ask a question..."
      : "Ask a research question...";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const useTextarea = !isMicro && !isCompact;

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleFocus = () => {
    if (!onFocusZoom) {
      return;
    }
    onFocusZoom(() => {
      requestAnimationFrame(() => {
        if (useTextarea) {
          textareaRef.current?.focus();
        }
      });
    });
  };

  return (
    <div
      className={`pointer-events-auto absolute z-10 text-foreground transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
      style={{ left, top, width: resolvedWidth }}
    >
      <div
        className={`flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 shadow-lg shadow-black/20 ${
          isMicro ? "px-1.5 py-1" : isCompact ? "px-2 py-1" : "px-2 py-1.5"
        }`}
      >
        {useTextarea ? (
          <Textarea
            value={prompt}
            onChange={(event) => {
              onPromptChange(event.target.value);
              setTimeout(() => adjustHeight(), 0);
            }}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            disabled={busy}
            onFocus={handleFocus}
            ref={textareaRef}
            rows={1}
            className={`resize-none overflow-y-auto border-transparent bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:ring-0 min-h-8 text-xs [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted/60 hover:[&::-webkit-scrollbar-thumb]:bg-muted`}
            style={{
              maxHeight: "160px",
              overflowY: "auto",
              scrollbarWidth: "thin",
              scrollbarColor: "var(--muted-foreground) transparent",
            }}
          />
        ) : (
          <Input
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            disabled={busy}
            onFocus={handleFocus}
            className={`border-transparent bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:ring-0 ${
              isMicro ? "h-6 text-[10px]" : "h-7 text-[11px]"
            }`}
          />
        )}
        <Button
          size="sm"
          className={`rounded-md bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 ${
            isMicro
              ? "h-6 px-2 text-[10px]"
              : isCompact
                ? "h-7 px-3 text-[11px]"
                : "h-8 px-4 text-xs"
          }`}
          onClick={onSend}
          disabled={busy || !prompt.trim()}
        >
          {busy ? "..." : "Send"}
        </Button>
      </div>
    </div>
  );
}
