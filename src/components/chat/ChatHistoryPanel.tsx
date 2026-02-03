import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../types/chat";
import { Button } from "@/components/ui/button";

interface ChatHistoryPanelProps {
  messages: ChatMessage[];
  selectedResponseId: string | null;
  input: string;
  busy: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
}

export default function ChatHistoryPanel({
  messages,
  selectedResponseId,
  input,
  busy,
  onInputChange,
  onSend,
}: ChatHistoryPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const highlightedId = selectedResponseId;

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (!highlightedId) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      return;
    }
    const target = scrollRef.current.querySelector<HTMLElement>(
      `[data-message-id="${highlightedId}"]`,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedId, messages.length]);

  return (
    <div className="pointer-events-auto absolute left-4 top-20 z-20 w-[360px]">
      <div className="flex max-h-[78vh] flex-col gap-3 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/80 p-4 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-white/60">
          <span>History</span>
          <span className="text-[10px] font-semibold text-white/40">
            {messages.length} MSG
          </span>
        </div>
        <div
          ref={scrollRef}
          className="flex flex-1 flex-col gap-3 overflow-auto pr-1 text-xs leading-relaxed text-white/80"
        >
          {messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/5 p-3 text-white/40">
              Ask a question to build the conversation.
            </div>
          ) : (
            messages.map((message) => {
              const isUser = message.role === "user";
              const isHighlighted = message.id === highlightedId;
              return (
                <div
                  key={message.id}
                  data-message-id={message.id}
                  className={`rounded-xl border border-white/10 p-3 transition ${
                    isUser ? "bg-white/5 text-white/80" : "bg-slate-900/70 text-white"
                  } ${isHighlighted ? "ring-1 ring-amber-400/60" : ""}`}
                >
                  <div className="text-[0.6rem] uppercase tracking-[0.3em] text-white/40">
                    {isUser ? "User" : "Assistant"}
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed">
                    {message.content}
                  </pre>
                </div>
              );
            })
          )}
          {busy && (
            <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3 text-white/60">
              <div className="text-[0.6rem] uppercase tracking-[0.3em] text-white/40">
                Assistant
              </div>
              <div className="mt-2 text-xs">Thinking...</div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-2 py-1.5 shadow-lg shadow-black/30">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask a question..."
            rows={1}
            disabled={busy}
            className="h-8 flex-1 resize-none bg-transparent px-2 text-xs text-white placeholder:text-white/40 focus:outline-none"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <Button
            size="sm"
            className="h-8 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 px-4 text-xs font-semibold text-slate-900 shadow-lg shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-xl"
            onClick={onSend}
            disabled={busy || !input.trim()}
          >
            {busy ? "..." : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
