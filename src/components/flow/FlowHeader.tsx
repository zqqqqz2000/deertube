import { Button } from "@/components/ui/button";

interface FlowHeaderProps {
  projectName: string;
  projectPath: string;
  busy: boolean;
  onOpenSettings: () => void;
  onExit: () => void;
  onFocusChat: () => void;
  onFocusGraph: () => void;
}

export default function FlowHeader({
  projectName,
  projectPath,
  busy,
  onOpenSettings,
  onExit,
  onFocusChat,
  onFocusGraph,
}: FlowHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-6 border-b border-white/10 bg-slate-950/80 px-8 py-5 backdrop-blur">
      <div>
        <div className="text-lg font-semibold text-white">{projectName}</div>
        <div className="text-xs text-white/50">{projectPath}</div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
          onClick={onFocusChat}
        >
          Chat
        </Button>
        <Button
          variant="outline"
          className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
          onClick={onFocusGraph}
        >
          Graph
        </Button>
        <Button
          variant="outline"
          className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
          onClick={onOpenSettings}
        >
          Settings
        </Button>
        <Button
          variant="outline"
          className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
          onClick={onExit}
          disabled={busy}
        >
          Switch project
        </Button>
      </div>
    </header>
  );
}
