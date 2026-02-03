import type { FlowEdge, FlowNode } from "../../types/flow";
import type { ChatMessage } from "../../types/chat";

export interface ProjectState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  chat: ChatMessage[];
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface FlowWorkspaceProps {
  project: ProjectInfo;
  initialState: ProjectState;
  onExit: () => void;
}
