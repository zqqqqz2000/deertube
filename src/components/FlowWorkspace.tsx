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
import type { IJsonModel, IJsonTabNode } from "@massbug/flexlayout-react";
import { Actions, DockLocation, Model } from "@massbug/flexlayout-react";
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
import type { InsightNodeData } from "../types/flow";
import { FlowFlexLayout } from "./flow/FlowFlexLayout";

const CHAT_TABSET_ID = "chat-tabset";
const GRAPH_TABSET_ID = "graph-tabset";
const CHAT_TAB_ID = "chat-tab";
const GRAPH_TAB_ID = "graph-tab";
const CHAT_DEFAULT_WEIGHT = 26;
const TOTAL_LAYOUT_WEIGHT = 100;

interface FlexLayoutNode {
  id?: string;
  type?: string;
  weight?: number;
  children?: FlexLayoutNode[];
}

const findLayoutNode = (
  node: FlexLayoutNode | undefined,
  id: string,
): FlexLayoutNode | null => {
  if (!node) {
    return null;
  }
  if (node.id === id) {
    return node;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findLayoutNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
};

const findFirstTabsetId = (node: FlexLayoutNode | undefined): string | null => {
  if (!node) {
    return null;
  }
  if (node.type === "tabset" && node.id) {
    return node.id;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findFirstTabsetId(child);
    if (found) {
      return found;
    }
  }
  return null;
};

const hasTab = (layout: FlexLayoutNode | undefined, tabId: string): boolean => {
  const node = findLayoutNode(layout, tabId);
  return Boolean(node && node.type === "tab");
};

const hasTabset = (layout: FlexLayoutNode | undefined, tabsetId: string): boolean => {
  const node = findLayoutNode(layout, tabsetId);
  return Boolean(node && node.type === "tabset");
};

const createDefaultLayoutModel = (): IJsonModel => ({
  global: {
    tabEnableFloat: false,
    tabEnableClose: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetMinWidth: 100,
    tabSetMinHeight: 100,
    borderMinSize: 100,
  },
  borders: [],
  layout: {
    type: "row",
    weight: TOTAL_LAYOUT_WEIGHT,
    children: [
      {
        type: "tabset",
        id: CHAT_TABSET_ID,
        weight: CHAT_DEFAULT_WEIGHT,
        selected: 0,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [
          {
            type: "tab",
            id: CHAT_TAB_ID,
            name: "Chat",
            component: "chat",
            enableClose: true,
          },
        ],
      },
      {
        type: "tabset",
        id: GRAPH_TABSET_ID,
        weight: TOTAL_LAYOUT_WEIGHT - CHAT_DEFAULT_WEIGHT,
        selected: 0,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [
          {
            type: "tab",
            id: GRAPH_TAB_ID,
            name: "Graph",
            component: "graph",
            enableClose: true,
          },
        ],
      },
    ],
  },
});

const createSingleTabLayoutModel = (tabKind: "chat" | "graph"): IJsonModel => {
  const tabId = tabKind === "chat" ? CHAT_TAB_ID : GRAPH_TAB_ID;
  const tabsetId = tabKind === "chat" ? CHAT_TABSET_ID : GRAPH_TABSET_ID;
  return {
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetMinWidth: 100,
      tabSetMinHeight: 100,
      borderMinSize: 100,
    },
    borders: [],
    layout: {
      type: "row",
      weight: TOTAL_LAYOUT_WEIGHT,
      children: [
        {
          type: "tabset",
          id: tabsetId,
          weight: TOTAL_LAYOUT_WEIGHT,
          selected: 0,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: tabId,
              name: tabKind === "chat" ? "Chat" : "Graph",
              component: tabKind,
              enableClose: true,
            },
          ],
        },
      ],
    },
  };
};

function FlowWorkspaceInner({
  project,
  initialState,
  theme,
  onToggleTheme,
  onExit,
}: FlowWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [chatScrollSignal, setChatScrollSignal] = useState(0);
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  const [layoutModel, setLayoutModel] = useState<IJsonModel>(
    () => createDefaultLayoutModel(),
  );
  const saveTimer = useRef<number | null>(null);
  const inputZoomRef = useRef<{ viewport: Viewport; nodeId: string } | null>(null);
  const nodeZoomRef = useRef<Viewport | null>(null);
  const { getNode } = useReactFlow();
  const flowStateOptions = useMemo(() => ({ autoSave: false }), []);

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
    messages: chatMessages,
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
    initialMessages: initialState.chat ?? [],
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
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const handleLayoutChange = useCallback((nextModel: IJsonModel) => {
    setLayoutModel(nextModel);
  }, []);

  const openOrFocusTab = useCallback(
    (tabKind: "chat" | "graph") => {
      const tabId = tabKind === "chat" ? CHAT_TAB_ID : GRAPH_TAB_ID;
      const tabsetId = tabKind === "chat" ? CHAT_TABSET_ID : GRAPH_TABSET_ID;
      const targetDock =
        tabKind === "chat" ? DockLocation.LEFT : DockLocation.RIGHT;

      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      const model = Model.fromJson(jsonModel);

      if (hasTab(layout, tabId)) {
        model.doAction(Actions.selectTab(tabId));
        handleLayoutChange(model.toJson());
        return;
      }

      const tab: IJsonTabNode = {
        type: "tab",
        id: tabId,
        name: tabKind === "chat" ? "Chat" : "Graph",
        component: tabKind,
        enableClose: true,
      };

      if (hasTabset(layout, tabsetId)) {
        model.doAction(
          Actions.addNode(tab, tabsetId, DockLocation.CENTER, -1, true),
        );
        handleLayoutChange(model.toJson());
        return;
      }

      const fallbackTabset = findFirstTabsetId(layout);
      if (!fallbackTabset) {
        handleLayoutChange(createSingleTabLayoutModel(tabKind));
        return;
      }

      model.doAction(Actions.addNode(tab, fallbackTabset, targetDock, -1, true));
      handleLayoutChange(model.toJson());
    },
    [handleLayoutChange, layoutModel],
  );

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

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      if (!flowInstance) {
        return;
      }
      setNodes((prev) =>
        prev.map((node) => ({
          ...node,
          selected: node.id === nodeId,
        })),
      );
      const internalNode = getNode(nodeId);
      const node = internalNode ?? nodes.find((item) => item.id === nodeId) ?? null;
      if (!node) {
        return;
      }
      const position =
        "positionAbsolute" in node && node.positionAbsolute
          ? node.positionAbsolute
          : node.position;
      const width = "width" in node ? node.width ?? 0 : 0;
      const height = "height" in node ? node.height ?? 0 : 0;
      const centerX = position.x + width / 2;
      const centerY = position.y + height / 2;
      requestAnimationFrame(() => {
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.05),
          duration: 400,
        });
      });
      setSelectedId(nodeId);
      setChatFocusSignal((prev) => prev + 1);
    },
    [flowInstance, getNode, nodes, setNodes, setSelectedId],
  );

  const handleNodeDoubleClick = useCallback(
    (_: unknown, node: { id: string }) => {
      if (!flowInstance) {
        return;
      }
      if (!nodeZoomRef.current) {
        nodeZoomRef.current = flowInstance.getViewport();
      }
      const internalNode = getNode(node.id);
      const position =
        internalNode?.positionAbsolute ?? internalNode?.position ?? { x: 0, y: 0 };
      const width = internalNode?.width ?? 0;
      const height = internalNode?.height ?? 0;
      const centerX = position.x + width / 2;
      const centerY = position.y + height / 2;
      requestAnimationFrame(() => {
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.6),
          duration: 450,
        });
      });
      setSelectedId(node.id);
      setChatFocusSignal((prev) => prev + 1);
    },
    [flowInstance, getNode, setSelectedId],
  );

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
    const isMicro = viewport.zoom <= 0.55;
    const isCompact = !isMicro && viewport.zoom <= 0.85;
    const minWidth = isMicro ? 160 : isCompact ? 200 : 240;
    const nodeScreenWidth = nodeWidth * viewport.zoom;
    const resolvedWidth = Math.max(nodeScreenWidth || minWidth, minWidth);
    const centerX = screenX + nodeScreenWidth / 2;
    const panelLeft = Math.max(0, centerX - resolvedWidth / 2);

    const handleInputFocusZoom = (focusInput: () => void) => {
      if (!flowInstance) {
        return;
      }
      if (!inputZoomRef.current) {
        inputZoomRef.current = { viewport: flowInstance.getViewport(), nodeId: selectedNode.id };
      }
      const centerX = position.x + nodeWidth / 2;
      const centerY = position.y + nodeHeight / 2;
      requestAnimationFrame(() => {
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.6),
          duration: 350,
        });
        focusInput();
      });
    };

    return (
      <FlowPanelInput
        visible={panelVisible}
        left={panelLeft}
        top={panelTop}
        width={resolvedWidth}
        zoom={viewport.zoom}
        prompt={panelInput}
        busy={busy}
        onPromptChange={setPanelInput}
        onSend={() => {
          void handleSendFromPanel();
          setChatScrollSignal((prev) => prev + 1);
        }}
        onFocusZoom={handleInputFocusZoom}
      />
    );
  };

  const renderTab = (tabId: string) => {
    if (tabId === "chat" || tabId === CHAT_TAB_ID) {
      return (
        <ChatHistoryPanel
          messages={chatMessages}
          selectedResponseId={selectedResponseId}
          selectedNode={selectedNode}
          nodes={nodes}
          onFocusNode={handleFocusNode}
          scrollToBottomSignal={chatScrollSignal}
          focusSignal={chatFocusSignal}
          onRequestClearSelection={() => setSelectedId(null)}
          input={historyInput}
          busy={chatBusy}
          graphBusy={graphBusy}
          onInputChange={setHistoryInput}
          onSend={handleSendFromHistory}
          onRetry={retryMessage}
        />
      );
    }
    if (tabId === "graph" || tabId === GRAPH_TAB_ID) {
      return (
        <div className="relative h-full w-full">
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
              setChatFocusSignal((prev) => prev + 1);
            }}
            selectNodesOnDrag={false}
            onPaneClick={() => {
              setSelectedId(null);
              if (flowInstance && inputZoomRef.current) {
                const { viewport } = inputZoomRef.current;
                inputZoomRef.current = null;
                requestAnimationFrame(() => {
                  flowInstance.setViewport(viewport, { duration: 350 });
                });
              }
              if (flowInstance && nodeZoomRef.current) {
                const viewport = nodeZoomRef.current;
                nodeZoomRef.current = null;
                requestAnimationFrame(() => {
                  flowInstance.setViewport(viewport, { duration: 350 });
                });
              }
            }}
            onNodeDragStart={() => setIsDragging(true)}
            onNodeDragStop={() => setIsDragging(false)}
            onNodeMouseEnter={handleNodeEnter}
            onNodeMouseLeave={handleNodeLeave}
            onNodeDoubleClick={handleNodeDoubleClick}
            zoomOnDoubleClick={false}
            defaultEdgeOptions={{
              type: "smoothstep",
              style: { stroke: "var(--flow-edge)", strokeWidth: 1.6 },
            }}
            className="h-full w-full"
            fitView
          >
            <Background gap={20} size={1} color="var(--flow-grid)" />
            <Panel position="top-right" className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="border-border/70 bg-card/80 text-xs uppercase tracking-[0.2em] text-muted-foreground hover:border-border hover:bg-accent/40 hover:text-foreground"
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
              className="rounded-xl border border-border/70 bg-card/80 text-foreground shadow-md"
            />
            <MiniMap
              className="rounded-xl border border-border/70 bg-card/70"
              zoomable
              pannable
            />
          </ReactFlow>
          {renderPanelInput()}
        </div>
      );
    }
    return null;
  };

  const renderTabLabel = useCallback(
    (tabId: string) => {
      if (tabId === "chat" || tabId === CHAT_TAB_ID) {
        return (
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="text-foreground">Chat</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {chatMessages.length} MSG
            </span>
          </div>
        );
      }
      if (tabId === "graph" || tabId === GRAPH_TAB_ID) {
        return <span className="text-sm font-medium text-foreground">Graph</span>;
      }
      return <span className="text-sm font-medium text-foreground">{tabId}</span>;
    },
    [chatMessages.length],
  );


  return (
    <QuestionActionProvider value={{ retryQuestion, busy }}>
      <div className="flex h-screen w-screen flex-col bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <FlowHeader
          projectName={project.name}
          projectPath={project.path}
          busy={busy}
          onOpenSettings={() => setSettingsOpen(true)}
          onFocusChat={() => openOrFocusTab("chat")}
          onFocusGraph={() => openOrFocusTab("graph")}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onExit={handleExit}
        />
        <div className="relative flex-1">
          <FlowFlexLayout
            model={layoutModel}
            onModelChange={handleLayoutChange}
            renderTab={renderTab}
            renderTabLabel={renderTabLabel}
          />
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
