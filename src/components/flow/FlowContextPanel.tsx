import { useMemo } from "react";

interface FlowContextPanelProps {
  visible: boolean;
  context: string;
}

export default function FlowContextPanel({
  visible,
  context,
}: FlowContextPanelProps) {
  const blocks = useMemo(() => {
    const trimmed = context.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed.split(/\n\n+/);
  }, [context]);
  const qaCount = blocks.length;

  return (
    <div
      className={`pointer-events-none absolute left-4 top-20 z-20 w-[320px] transition-all duration-300 ${
        visible ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
      }`}
    >
      <div className="pointer-events-auto flex max-h-[70vh] flex-col gap-3 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/80 p-4 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-white/60">
          <span>Context</span>
          <span className="text-[10px] font-semibold text-white/40">
            {qaCount} QA
          </span>
        </div>
        <div className="flex flex-col gap-3 overflow-auto pr-1 text-xs leading-relaxed text-white/80">
          {blocks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/5 p-3 text-white/40">
              Select a node to preview the root-to-node QA context.
            </div>
          ) : (
            blocks.map((block, index) => (
              <div
                key={`qa-${index}`}
                className="rounded-xl border border-white/10 bg-slate-900/60 p-3"
              >
                <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-100">
                  {block}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
