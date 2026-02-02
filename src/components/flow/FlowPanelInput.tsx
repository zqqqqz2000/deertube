import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface FlowPanelInputProps {
  visible: boolean;
  left: number;
  top: number;
  width?: number;
  prompt: string;
  busy: boolean;
  onPromptChange: (value: string) => void;
  onSend: () => void;
}

export default function FlowPanelInput({
  visible,
  left,
  top,
  width,
  prompt,
  busy,
  onPromptChange,
  onSend,
}: FlowPanelInputProps) {
  return (
    <div
      className={`pointer-events-auto absolute z-10 text-white transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
      style={{ left, top, width }}
    >
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-2 py-1.5 shadow-lg shadow-black/30">
        <Input
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="Ask a research question..."
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
          className="h-8 border-transparent bg-transparent text-xs text-white placeholder:text-white/40 focus-visible:ring-0"
        />
        <Button
          size="sm"
          className="h-8 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 px-4 text-xs font-semibold text-slate-900 shadow-lg shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-xl"
          onClick={onSend}
          disabled={busy || !prompt.trim()}
        >
          {busy ? "..." : "Send"}
        </Button>
      </div>
    </div>
  );
}
