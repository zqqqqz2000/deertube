import type { FlowEdge, FlowNode } from "../../types/flow";
import type { ChatMessage } from "../../types/chat";
import type { Theme } from "../../lib/theme";

export interface ProjectState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  chat: ChatMessage[];
  autoLayoutLocked?: boolean;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface FlowWorkspaceProps {
  project: ProjectInfo;
  initialState: ProjectState;
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
  saveEnabled?: boolean;
}
