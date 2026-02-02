import type { FlowEdge, FlowNode } from "../../types/flow";

export interface ProjectState {
  nodes: FlowNode[];
  edges: FlowEdge[];
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
