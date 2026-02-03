import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  type ReactFlowInstance,
  type Viewport,
  useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import { trpc } from "../lib/trpc";
import QuestionNode from "./nodes/QuestionNode";
import SourceNode from "./nodes/SourceNode";
import InsightNode from "./nodes/InsightNode";
import SettingsPanel from "./SettingsPanel";
import { Button } from "@/components/ui/button";
import { createProfileDraft } from "../lib/settings";
import FlowHeader from "./flow/FlowHeader";
import FlowPanelInput from "./flow/FlowPanelInput";
import type { FlowWorkspaceProps } from "./flow/types";
import { useAutoLayout } from "./flow/useAutoLayout";
import { useFlowState } from "./flow/useFlowState";
import { useInitialFit } from "./flow/useInitialFit";
import { usePanelState } from "./flow/usePanelState";
import { usePreviewHover } from "./flow/usePreviewHover";
import { useProfileSettings } from "./flow/useProfileSettings";
import { useChatActions } from "./flow/useChatActions";
import { QuestionActionProvider } from "./flow/QuestionActionProvider";
import ChatHistoryPanel from "./chat/ChatHistoryPanel";
import type { ChatMessage } from "../types/chat";
import type { InsightNodeData } from "../types/flow";

function FlowWorkspaceInner({
  project,
  initialState,
  onExit,
}: FlowWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    initialState.chat ?? [],
  );
  const saveTimer = useRef<number | null>(null);
  const { getNode } = useReactFlow();
  const flowStateOptions = useMemo(
    () => ({ onInitialRootSelect: setSelectedId, autoSave: false }),
    [setSelectedId],
  );

  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    hydrated,
  } = useFlowState(initialState, project.path, flowStateOptions);
  const {
    profiles,
    setProfiles,
    activeProfileId,
    setActiveProfileId,
    activeProfile,
  } = useProfileSettings(project.path);
  const { panelVisible, panelNodeId } = usePanelState(selectedId, isDragging);
  const displayEdges = useMemo(() => edges, [edges]);
  const {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    busy,
    chatBusy,
    graphBusy,
    retryMessage,
    handleSendFromHistory,
    handleSendFromPanel,
  } = useChatActions({
    projectPath: project.path,
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedId,
    flowInstance,
    activeProfile,
    messages: chatMessages,
    setMessages: setChatMessages,
  });
  const { isLayouting, handleAutoLayout } = useAutoLayout({
    flowInstance,
    nodes,
    edges,
    setNodes,
  });
  const { handleNodeEnter, handleNodeLeave } = usePreviewHover();
  const retryQuestion = useCallback(() => undefined, []);

  useInitialFit(flowInstance, nodes.length);

  const nodeTypes = useMemo(
    () => ({ question: QuestionNode, source: SourceNode, insight: InsightNode }),
    [],
  );

  const selectedResponseId = useMemo(() => {
    const selectedNode = nodes.find((node) => node.id === selectedId);
    if (!selectedNode || selectedNode.type !== "insight") {
      return null;
    }
    const data = selectedNode.data as InsightNodeData;
    return data.responseId ?? null;
  }, [nodes, selectedId]);

  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      trpc.project.saveState
        .mutate({
          path: project.path,
          state: {
            nodes,
            edges,
            chat: chatMessages,
            version: 1,
          },
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [chatMessages, edges, nodes, project.path, hydrated]);

  const handleExit = () => {
    trpc.preview.hide.mutate().catch(() => undefined);
    onExit();
  };

  const renderPanelInput = () => {
    if (!panelNodeId || !flowInstance) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === panelNodeId);
    if (!selectedNode) {
      return null;
    }
    const internalNode = getNode(selectedNode.id);
    const position =
      internalNode?.positionAbsolute ??
      selectedNode.positionAbsolute ??
      selectedNode.position;
    const nodeWidth = internalNode?.width ?? selectedNode.width ?? 0;
    const nodeHeight = internalNode?.height ?? 0;
    const screenX = position.x * viewport.zoom + viewport.x;
    const screenY = position.y * viewport.zoom + viewport.y;
    const panelTop = screenY + nodeHeight * viewport.zoom + 10 * viewport.zoom;

    return (
      <FlowPanelInput
        visible={panelVisible}
        left={screenX}
        top={panelTop}
        width={nodeWidth ? nodeWidth * viewport.zoom : undefined}
        prompt={panelInput}
        busy={busy}
        onPromptChange={setPanelInput}
        onSend={() => {
          void handleSendFromPanel();
        }}
      />
    );
  };

  return (
    <QuestionActionProvider value={{ retryQuestion, busy }}>
      <div className="flex h-screen w-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
        <FlowHeader
          projectName={project.name}
          projectPath={project.path}
          busy={busy}
          onOpenSettings={() => setSettingsOpen(true)}
          onExit={handleExit}
        />
        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              setFlowInstance(instance);
              setViewport(instance.getViewport());
            }}
            onMove={(_, nextViewport) => setViewport(nextViewport)}
            onMoveStart={() => setIsDragging(true)}
            onMoveEnd={() => setIsDragging(false)}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
              setPanelInput("");
            }}
            selectNodesOnDrag={false}
            onPaneClick={() => setSelectedId(null)}
            onNodeDragStart={() => setIsDragging(true)}
            onNodeDragStop={() => setIsDragging(false)}
            onNodeMouseEnter={handleNodeEnter}
            onNodeMouseLeave={handleNodeLeave}
            defaultEdgeOptions={{
              type: "smoothstep",
              style: { stroke: "rgba(255,255,255,0.35)", strokeWidth: 1.6 },
            }}
            className="h-full w-full"
            fitView
          >
            <Background gap={20} size={1} color="rgba(255,255,255,0.08)" />
            <Panel position="top-right" className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="border-white/15 bg-slate-900/80 text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
                onClick={() => {
                  void handleAutoLayout();
                }}
                disabled={isLayouting || nodes.length === 0}
              >
                {isLayouting ? "Layout..." : "Auto layout"}
              </Button>
            </Panel>
            <Controls
              showInteractive={false}
              className="rounded-xl border border-white/10 bg-slate-900/80 text-white"
            />
            <MiniMap
              className="rounded-xl border border-white/10 bg-slate-900/70"
              zoomable
              pannable
            />
          </ReactFlow>
          <ChatHistoryPanel
            messages={chatMessages}
            selectedResponseId={selectedResponseId}
            input={historyInput}
            busy={chatBusy}
            graphBusy={graphBusy}
            onInputChange={setHistoryInput}
            onSend={handleSendFromHistory}
            onRetry={retryMessage}
          />
          {renderPanelInput()}
        </div>
        <SettingsPanel
          open={settingsOpen}
          profiles={profiles}
          activeProfileId={activeProfileId}
          onClose={() => setSettingsOpen(false)}
          onActiveProfileChange={(id) => setActiveProfileId(id)}
          onProfileAdd={() => {
            setProfiles((prev) => {
              const nextIndex = prev.length + 1;
              return [...prev, createProfileDraft(`Profile ${nextIndex}`)];
            });
          }}
          onProfileDelete={(id) => {
            setProfiles((prev) => {
              const next = prev.filter((profile) => profile.id !== id);
              if (activeProfileId === id) {
                setActiveProfileId(next[0]?.id ?? null);
              }
              return next;
            });
          }}
          onProfileChange={(id, patch) => {
            setProfiles((prev) =>
              prev.map((profile) =>
                profile.id === id ? { ...profile, ...patch } : profile,
              ),
            );
          }}
        />
      </div>
    </QuestionActionProvider>
  );
}

export default function FlowWorkspace(props: FlowWorkspaceProps) {
  return (
    <ReactFlowProvider>
      <FlowWorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}
