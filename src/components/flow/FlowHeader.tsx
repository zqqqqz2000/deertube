import { Button } from "@/components/ui/button";
import {
  ExternalLink,
  FolderOpen,
  MessageSquare,
  Moon,
  Network,
  Settings,
  Sun,
} from "lucide-react";
import type { Theme } from "@/lib/theme";

interface FlowHeaderProps {
  projectName: string;
  projectPath: string;
  busy: boolean;
  onOpenSettings: () => void;
  onExit: () => void;
  onFocusChat: () => void;
  onFocusGraph: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export default function FlowHeader({
  projectName,
  projectPath,
  busy,
  onOpenSettings,
  onExit,
  onFocusChat,
  onFocusGraph,
  theme,
  onToggleTheme,
}: FlowHeaderProps) {
  const ToggleIcon = theme === "dark" ? Sun : Moon;
  const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined;
  const handleOpenSource = () => {
    if (sourceUrl) {
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <header className="flex flex-wrap items-center justify-between gap-6 border-b border-border/60 bg-background/70 px-6 py-4 backdrop-blur-xl">
      <div>
        <div className="text-lg font-semibold text-foreground">
          {projectName}
        </div>
        <div className="text-xs text-muted-foreground">{projectPath}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
          onClick={onFocusChat}
          aria-label="Focus chat"
          title="Focus chat"
        >
          <MessageSquare />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
          onClick={onFocusGraph}
          aria-label="Focus graph"
          title="Focus graph"
        >
          <Network />
        </Button>
        {sourceUrl ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
            onClick={handleOpenSource}
            aria-label="View source code"
            title="View source code"
          >
            <ExternalLink />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Open settings"
        >
          <Settings />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
          onClick={onToggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
          title={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
        >
          <ToggleIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-border/60 bg-background/60 text-foreground/80 shadow-sm hover:bg-accent hover:text-accent-foreground"
          onClick={onExit}
          disabled={busy}
          aria-label="Switch project"
          title="Switch project"
        >
          <FolderOpen />
        </Button>
      </div>
    </header>
  );
}
