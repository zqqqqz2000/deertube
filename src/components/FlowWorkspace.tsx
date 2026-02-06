import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
import type { IpcRendererEvent } from "electron";
import QuestionNode from "./nodes/QuestionNode";
import SourceNode from "./nodes/SourceNode";
import InsightNode from "./nodes/InsightNode";
import SettingsPanel from "./SettingsPanel";
import { Button } from "@/components/ui/button";
import { Globe, LayoutGrid, Lock, LockOpen, MessageSquare, Network } from "lucide-react";
import { createProfileDraft } from "../lib/settings";
import { getNodeSize } from "../lib/elkLayout";
import FlowHeader from "./flow/FlowHeader";
import FlowPanelInput from "./flow/FlowPanelInput";
import type { FlowWorkspaceProps, ProjectState } from "./flow/types";
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
import type { ChatMessage } from "../types/chat";
import { FlowFlexLayout } from "./flow/FlowFlexLayout";
import { BrowserTab } from "./browser/BrowserTab";
import type {
  BrowserViewBounds,
  BrowserViewReferenceHighlight,
  BrowserViewSelection,
  BrowserViewStatePayload,
  BrowserViewTabState,
} from "../types/browserview";
import {
  isDeepResearchRefUri,
  type DeepResearchResolvedReference,
} from "@/shared/deepresearch";

const CHAT_TABSET_ID = "chat-tabset";
const GRAPH_TABSET_ID = "graph-tabset";
const CHAT_TAB_ID = "chat-tab";
const GRAPH_TAB_ID = "graph-tab";
const CHAT_DEFAULT_WEIGHT = 26;
const TOTAL_LAYOUT_WEIGHT = 100;
const BROWSER_TAB_PREFIX = "browser:";
const BROWSER_TAB_MAX_LABEL_LENGTH = 36;

type ProjectStateInput = Omit<ProjectState, "chat"> & { chat?: ChatMessage[] };

const coerceProjectState = (state: ProjectStateInput): ProjectState => ({
  nodes: state.nodes,
  edges: state.edges,
  chat: state.chat ?? [],
  autoLayoutLocked:
    typeof state.autoLayoutLocked === "boolean" ? state.autoLayoutLocked : true,
});

interface FlexLayoutNode {
  id?: string;
  type?: string;
  weight?: number;
  component?: string;
  selected?: number;
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

const parseBrowserTabId = (value: string) => {
  if (value.startsWith(BROWSER_TAB_PREFIX)) {
    return value.slice(BROWSER_TAB_PREFIX.length);
  }
  if (value.startsWith("browser-")) {
    return value;
  }
  return null;
};

const isHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const normalizeBrowserLabel = (label?: string) => {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const truncateLabel = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return ".".repeat(Math.max(0, maxLength));
  }
  return `${value.slice(0, maxLength - 3)}...`;
};

const collectBrowserTabIds = (node: FlexLayoutNode | undefined): Set<string> => {
  const ids = new Set<string>();
  const visit = (current?: FlexLayoutNode) => {
    if (!current) {
      return;
    }
    if (current.type === "tab" && current.id) {
      const component = current.component ?? current.id;
      const tabId = parseBrowserTabId(String(component));
      if (tabId) {
        ids.add(tabId);
      }
    }
    if (current.children) {
      current.children.forEach((child) => visit(child));
    }
  };
  visit(node);
  return ids;
};

const collectVisibleBrowserTabIds = (
  node: FlexLayoutNode | undefined,
): Set<string> => {
  const ids = new Set<string>();
  const visit = (current?: FlexLayoutNode) => {
    if (!current) {
      return;
    }
    if (current.type === "tabset" && Array.isArray(current.children)) {
      const selectedValue = current.selected;
      let selectedNode: FlexLayoutNode | undefined;
      if (typeof selectedValue === "number" && current.children[selectedValue]) {
        selectedNode = current.children[selectedValue];
      } else if (typeof selectedValue === "string") {
        selectedNode = current.children.find(
          (child) =>
            child.type === "tab" &&
            (child.id === selectedValue || child.component === selectedValue),
        );
      }
      if (!selectedNode) {
        selectedNode = current.children[0];
      }
      if (selectedNode?.type === "tab") {
        const component = selectedNode.component ?? selectedNode.id;
        const tabId = component ? parseBrowserTabId(String(component)) : null;
        if (tabId) {
          ids.add(tabId);
        }
      }
      return;
    }
    if (current.children) {
      current.children.forEach((child) => visit(child));
    }
  };
  visit(node);
  return ids;
};

const hasTab = (layout: FlexLayoutNode | undefined, tabId: string): boolean => {
  const node = findLayoutNode(layout, tabId);
  return Boolean(node && node.type === "tab");
};

const hasTabset = (layout: FlexLayoutNode | undefined, tabsetId: string): boolean => {
  const node = findLayoutNode(layout, tabsetId);
  return Boolean(node && node.type === "tabset");
};

const normalizeLayoutModel = (model: IJsonModel): IJsonModel => {
  const next = JSON.parse(JSON.stringify(model)) as IJsonModel;
  next.global = {
    ...next.global,
    tabEnableFloat: false,
    tabEnableClose: true,
    tabEnableRenderOnDemand: false,
    tabSetAutoSelectTab: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetMinWidth: 100,
    tabSetMinHeight: 100,
    borderMinSize: 100,
  };

  const ensureSelected = (node: FlexLayoutNode | undefined) => {
    if (!node?.children) {
      return;
    }
    if (node.type === "tabset" && node.children.length > 0) {
      const selected = typeof node.selected === "number" ? node.selected : undefined;
      if (selected === undefined || selected < 0) {
        node.selected = 0;
      }
    }
    node.children.forEach((child) => ensureSelected(child));
  };

  ensureSelected(next.layout as FlexLayoutNode);
  return next;
};

const createDefaultLayoutModel = (): IJsonModel =>
  normalizeLayoutModel({
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
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
  return normalizeLayoutModel({
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
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
  });
};

const createSingleBrowserLayoutModel = (
  tabId: string,
  label?: string,
): IJsonModel => {
  const resolvedLabel = normalizeBrowserLabel(label);
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
          id: GRAPH_TABSET_ID,
          weight: TOTAL_LAYOUT_WEIGHT,
          selected: 0,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: tabId,
              name: resolvedLabel ?? "Browser",
              component: `${BROWSER_TAB_PREFIX}${tabId}`,
              enableClose: true,
            },
          ],
        },
      ],
    },
  };
};

function FlowWorkspaceLoader(props: FlowWorkspaceProps) {
  const [loadedState, setLoadedState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const lastPathRef = useRef<string | null>(null);
  const saveEnabled = props.saveEnabled ?? true;

  useEffect(() => {
    let cancelled = false;
    const samePath = lastPathRef.current === props.project.path;
    lastPathRef.current = props.project.path;
    setLoading(true);
    if (!samePath) {
      setLoadedState(null);
    }
    trpc.project.open
      .mutate({ path: props.project.path })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setLoadedState(coerceProjectState(result.state));
        setReloadKey((prev) => prev + 1);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLoadedState((prev) => prev ?? props.initialState);
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.initialState, props.project.path]);

  if (loading && !loadedState) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <div className="rounded-xl border border-border/70 bg-card/80 px-6 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
          Reloading project...
        </div>
      </div>
    );
  }

  if (!loadedState) {
    return null;
  }

  return (
    <div className="relative h-screen w-screen">
      <FlowWorkspaceInner
        key={reloadKey}
        {...props}
        initialState={loadedState}
        saveEnabled={saveEnabled && !loading}
      />
      {loading ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="rounded-xl border border-border/70 bg-card/90 px-5 py-3 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
            Reloading project...
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FlowWorkspaceInner({
  project,
  initialState,
  theme,
  onToggleTheme,
  onExit,
  saveEnabled = true,
}: FlowWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [autoLayoutLocked, setAutoLayoutLocked] = useState(
    () => initialState.autoLayoutLocked ?? true,
  );
  const [chatScrollSignal, setChatScrollSignal] = useState(0);
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  const [layoutModel, setLayoutModel] = useState<IJsonModel>(
    () => createDefaultLayoutModel(),
  );
  const [browserTabs, setBrowserTabs] = useState<BrowserViewTabState[]>([]);
  const [browserBounds, setBrowserBounds] = useState<
    Record<string, BrowserViewBounds>
  >({});
  const [browserSelection, setBrowserSelection] =
    useState<BrowserViewSelection | null>(null);
  const previousBrowserTabIdsRef = useRef<Set<string>>(new Set());
  const visibleBrowserTabsRef = useRef<Set<string>>(new Set());
  const openedBrowserTabsRef = useRef<Set<string>>(new Set());
  const browserTabsRef = useRef<BrowserViewTabState[]>([]);
  const browserBoundsRef = useRef<Record<string, BrowserViewBounds>>({});
  const browserHighlightTimersRef = useRef<Set<number>>(new Set());
  const referenceResolveCacheRef = useRef<
    Map<string, DeepResearchResolvedReference | null>
  >(new Map());
  const saveTimer = useRef<number | null>(null);
  const inputZoomRef = useRef<{ viewport: Viewport; nodeId: string } | null>(null);
  const nodeZoomRef = useRef<Viewport | null>(null);
  const autoLayoutPendingRef = useRef(false);
  const autoLayoutWasRunningRef = useRef(false);
  const autoLayoutZoomingRef = useRef(false);
  const autoLayoutZoomTimeoutRef = useRef<number | null>(null);
  const autoLayoutLockEntryPendingRef = useRef(autoLayoutLocked);
  const autoLayoutLockPreviousRef = useRef(autoLayoutLocked);
  const autoLayoutLastSizesRef = useRef<
    Map<string, { width: number; height: number }> | null
  >(null);
  const autoLayoutLastCountRef = useRef<number | null>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
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
  const lastFailedMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index];
      if (
        message.kind === "graph-event" ||
        message.kind === "subagent-event" ||
        message.kind === "deepsearch-event"
      ) {
        continue;
      }
      return message.status === "failed" ? message.id : null;
    }
    return null;
  }, [chatMessages]);
  const { isLayouting, handleAutoLayout } = useAutoLayout({
    flowInstance,
    nodes,
    edges,
    setNodes,
    focusNodeId: selectedId,
  });
  const { handleNodeEnter, handleNodeLeave } = usePreviewHover();
  const retryQuestion = useCallback(() => undefined, []);

  useInitialFit(flowInstance, nodes.length);

  const nodeTypes = useMemo(
    () => ({ question: QuestionNode, source: SourceNode, insight: InsightNode }),
    [],
  );

  const suspendAutoLayoutForZoom = useCallback(
    (durationMs: number) => {
      if (!autoLayoutLocked) {
        return;
      }
      autoLayoutZoomingRef.current = true;
      if (autoLayoutZoomTimeoutRef.current) {
        window.clearTimeout(autoLayoutZoomTimeoutRef.current);
      }
      autoLayoutZoomTimeoutRef.current = window.setTimeout(() => {
        autoLayoutZoomingRef.current = false;
        autoLayoutZoomTimeoutRef.current = null;
        if (!autoLayoutLocked) {
          autoLayoutPendingRef.current = false;
          return;
        }
        if (!autoLayoutPendingRef.current || isLayouting) {
          return;
        }
        autoLayoutPendingRef.current = false;
        void handleAutoLayout();
      }, durationMs);
    },
    [autoLayoutLocked, handleAutoLayout, isLayouting],
  );

  useEffect(() => {
    if (!autoLayoutLocked) {
      autoLayoutPendingRef.current = false;
      autoLayoutLastSizesRef.current = null;
      autoLayoutLastCountRef.current = null;
      autoLayoutZoomingRef.current = false;
      if (autoLayoutZoomTimeoutRef.current) {
        window.clearTimeout(autoLayoutZoomTimeoutRef.current);
        autoLayoutZoomTimeoutRef.current = null;
      }
      return;
    }
    const resolveDimension = (value: number | null | undefined) =>
      typeof value === "number" && value > 0 ? value : undefined;
    const currentSizes = new Map<string, { width: number; height: number }>();
    nodes.forEach((node) => {
      const internal = flowInstance?.getNode(node.id);
      const width =
        resolveDimension(internal?.width) ?? resolveDimension(node.width);
      const height =
        resolveDimension(internal?.height) ?? resolveDimension(node.height);
      const size = getNodeSize({
        ...node,
        width,
        height,
      });
      currentSizes.set(node.id, size);
    });

    const previousSizes = autoLayoutLastSizesRef.current;
    const previousCount = autoLayoutLastCountRef.current;
    const countChanged =
      typeof previousCount === "number" && nodes.length !== previousCount;
    let sizeChanged = false;
    if (previousSizes && previousSizes.size === currentSizes.size) {
      for (const [id, size] of currentSizes) {
        const previousSize = previousSizes.get(id);
        if (!previousSize) {
          sizeChanged = true;
          break;
        }
        if (
          previousSize.width !== size.width ||
          previousSize.height !== size.height
        ) {
          sizeChanged = true;
          break;
        }
      }
    } else if (previousSizes) {
      sizeChanged = true;
    }

    const shouldLayout = countChanged || sizeChanged;
    autoLayoutLastSizesRef.current = currentSizes;
    autoLayoutLastCountRef.current = nodes.length;

    if (!shouldLayout) {
      return;
    }
    if (autoLayoutZoomingRef.current) {
      autoLayoutPendingRef.current = true;
      return;
    }
    if (isLayouting) {
      autoLayoutPendingRef.current = true;
      return;
    }
    void handleAutoLayout();
  }, [
    autoLayoutLocked,
    flowInstance,
    handleAutoLayout,
    isLayouting,
    nodes,
    viewport.zoom,
  ]);

  useEffect(() => {
    const previous = autoLayoutLockPreviousRef.current;
    if (!previous && autoLayoutLocked) {
      autoLayoutLockEntryPendingRef.current = true;
    }
    autoLayoutLockPreviousRef.current = autoLayoutLocked;
  }, [autoLayoutLocked]);

  useEffect(() => {
    if (!autoLayoutLockEntryPendingRef.current) {
      return;
    }
    if (!autoLayoutLocked) {
      return;
    }
    if (!hydrated.current || !flowInstance || nodes.length === 0) {
      return;
    }
    if (isLayouting) {
      return;
    }
    autoLayoutLockEntryPendingRef.current = false;
    void handleAutoLayout();
  }, [autoLayoutLocked, flowInstance, handleAutoLayout, hydrated, isLayouting, nodes.length]);

  useEffect(() => {
    const wasLayouting = autoLayoutWasRunningRef.current;
    autoLayoutWasRunningRef.current = isLayouting;
    if (!wasLayouting || isLayouting) {
      return;
    }
    if (autoLayoutLockEntryPendingRef.current) {
      autoLayoutLockEntryPendingRef.current = false;
    }
    if (!autoLayoutLocked) {
      autoLayoutPendingRef.current = false;
      return;
    }
    if (!autoLayoutPendingRef.current) {
      return;
    }
    autoLayoutPendingRef.current = false;
    void handleAutoLayout();
  }, [autoLayoutLocked, handleAutoLayout, isLayouting]);
  const browserTabMap = useMemo(
    () => new Map(browserTabs.map((tab) => [tab.id, tab])),
    [browserTabs],
  );

  useEffect(() => {
    browserTabsRef.current = browserTabs;
  }, [browserTabs]);

  useEffect(() => {
    browserBoundsRef.current = browserBounds;
  }, [browserBounds]);

  useEffect(() => {
    referenceResolveCacheRef.current.clear();
  }, [project.path]);

  useEffect(() => {
    const highlightTimers = browserHighlightTimersRef.current;
    return () => {
      highlightTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      highlightTimers.clear();
      const tabs = browserTabsRef.current;
      tabs.forEach((tab) => {
        trpc.browserView.close.mutate({ tabId: tab.id }).catch(() => undefined);
      });
      trpc.browserView.hide.mutate().catch(() => undefined);
    };
  }, []);

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
    setLayoutModel(normalizeLayoutModel(nextModel));
  }, []);

  useEffect(() => {
    const layout = layoutModel.layout as FlexLayoutNode | undefined;
    const existingIds = collectBrowserTabIds(layout);
    const visibleIds = collectVisibleBrowserTabIds(layout);
    visibleBrowserTabsRef.current = visibleIds;
    const previousIds = previousBrowserTabIdsRef.current;
    previousIds.forEach((tabId) => {
      if (!existingIds.has(tabId)) {
        trpc.browserView.close.mutate({ tabId }).catch(() => undefined);
        openedBrowserTabsRef.current.delete(tabId);
      }
    });
    previousBrowserTabIdsRef.current = existingIds;
    setBrowserTabs((prev) => prev.filter((tab) => existingIds.has(tab.id)));
    setBrowserBounds((prev) => {
      const next: Record<string, BrowserViewBounds> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (existingIds.has(key)) {
          next[key] = value;
        }
      });
      return next;
    });
    const boundsMap = browserBoundsRef.current;
    const tabs = browserTabsRef.current;
    const tabLookup = new Map(tabs.map((tab) => [tab.id, tab]));

    existingIds.forEach((tabId) => {
      if (!visibleIds.has(tabId)) {
        trpc.browserView.hideTab.mutate({ tabId }).catch(() => undefined);
      }
    });

    visibleIds.forEach((tabId) => {
      const tab = tabLookup.get(tabId);
      const bounds = boundsMap[tabId];
      if (!tab || !bounds || bounds.width <= 1 || bounds.height <= 1) {
        return;
      }
      if (!openedBrowserTabsRef.current.has(tabId)) {
        trpc.browserView
          .open
          .mutate({
            tabId,
            url: tab.url,
            bounds,
          })
          .catch(() => undefined);
        openedBrowserTabsRef.current.add(tabId);
        return;
      }
      trpc.browserView
        .updateBounds
        .mutate({
          tabId,
          bounds,
        })
        .catch(() => undefined);
    });
  }, [layoutModel]);

  useEffect(() => {
    const ipc = window.ipcRenderer;
    if (!ipc) {
      return;
    }
    const handleState = (
      _event: IpcRendererEvent,
      payload: BrowserViewStatePayload,
    ) => {
      if (!payload?.tabId) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === payload.tabId
            ? {
                ...tab,
                url: payload.url ?? tab.url,
                title: payload.title ?? tab.title,
                canGoBack: payload.canGoBack ?? tab.canGoBack,
                canGoForward: payload.canGoForward ?? tab.canGoForward,
              }
            : tab,
        ),
      );
    };
    const handleSelection = (
      _event: IpcRendererEvent,
      payload: BrowserViewSelection,
    ) => {
      if (!payload) {
        return;
      }
      const text = payload.text?.trim();
      if (!text) {
        setBrowserSelection(null);
        return;
      }
      setBrowserSelection(payload);
    };

    ipc.on("browserview-state", handleState);
    ipc.on("browserview-selection", handleSelection);
    return () => {
      ipc.off("browserview-state", handleState);
      ipc.off("browserview-selection", handleSelection);
    };
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

  const selectBrowserTab = useCallback(
    (tabId: string) => {
      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      if (!hasTab(layout, tabId)) {
        return false;
      }
      const model = Model.fromJson(jsonModel);
      model.doAction(Actions.selectTab(tabId));
      handleLayoutChange(model.toJson());
      return true;
    },
    [handleLayoutChange, layoutModel],
  );

  const openBrowserUrl = useCallback(
    (rawUrl: string, label?: string): string | null => {
      if (!isHttpUrl(rawUrl)) {
        return null;
      }
      const normalized = new URL(rawUrl).toString();
      const existing = browserTabs.find((tab) => tab.url === normalized);
      if (existing) {
        selectBrowserTab(existing.id);
        return existing.id;
      }

      const tabId = `browser-${crypto.randomUUID()}`;
      const resolvedLabel = normalizeBrowserLabel(label);
      const nextTab: BrowserViewTabState = {
        id: tabId,
        url: normalized,
        title: resolvedLabel,
      };
      setBrowserTabs((prev) => [...prev, nextTab]);

      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      const model = Model.fromJson(jsonModel);
      const tab: IJsonTabNode = {
        type: "tab",
        id: tabId,
        name: resolvedLabel ?? "Browser",
        component: `${BROWSER_TAB_PREFIX}${tabId}`,
        enableClose: true,
      };

      if (hasTabset(layout, GRAPH_TABSET_ID)) {
        model.doAction(
          Actions.addNode(tab, GRAPH_TABSET_ID, DockLocation.CENTER, -1, true),
        );
        handleLayoutChange(model.toJson());
        return tabId;
      }

      const fallbackTabset = findFirstTabsetId(layout);
      if (!fallbackTabset) {
        handleLayoutChange(createSingleBrowserLayoutModel(tabId, resolvedLabel));
        return tabId;
      }
      model.doAction(
        Actions.addNode(tab, fallbackTabset, DockLocation.RIGHT, -1, true),
      );
      handleLayoutChange(model.toJson());
      return tabId;
    },
    [browserTabs, handleLayoutChange, layoutModel, selectBrowserTab],
  );

  const scheduleBrowserReferenceHighlight = useCallback(
    (
      tabId: string,
      reference: DeepResearchResolvedReference,
      attempt = 0,
    ) => {
      if (attempt > 8) {
        return;
      }
      const delay = attempt === 0 ? 180 : Math.min(1300, 220 * (attempt + 1));
      const timerId = window.setTimeout(() => {
        browserHighlightTimersRef.current.delete(timerId);
        const payload: BrowserViewReferenceHighlight = {
          refId: reference.refId,
          text: reference.text,
          startLine: reference.startLine,
          endLine: reference.endLine,
        };
        trpc.browserView.highlightReference
          .mutate({
            tabId,
            reference: payload,
          })
          .then((result) => {
            if (!result.ok) {
              scheduleBrowserReferenceHighlight(tabId, reference, attempt + 1);
            }
          })
          .catch(() => {
            scheduleBrowserReferenceHighlight(tabId, reference, attempt + 1);
          });
      }, delay);
      browserHighlightTimersRef.current.add(timerId);
    },
    [],
  );

  const resolveBrowserReference = useCallback(
    async (uri: string) => {
      const normalizedUri = uri.trim();
      if (!normalizedUri) {
        return null;
      }
      const isDeertubeRef = normalizedUri.toLowerCase().startsWith("deertube://");
      if (!isDeertubeRef && !isDeepResearchRefUri(normalizedUri)) {
        return null;
      }
      const cached = referenceResolveCacheRef.current.get(normalizedUri);
      if (cached !== undefined) {
        return cached;
      }
      try {
        const result = await trpc.deepSearch.resolveReference.mutate({
          projectPath: project.path,
          uri: normalizedUri,
        });
        const reference = result.reference ?? null;
        referenceResolveCacheRef.current.set(normalizedUri, reference);
        return reference;
      } catch {
        referenceResolveCacheRef.current.set(normalizedUri, null);
        return null;
      }
    },
    [project.path],
  );

  const resolveReferencePreview = useCallback(
    async (uri: string) => {
      const reference = await resolveBrowserReference(uri);
      if (!reference) {
        return null;
      }
      return {
        title: reference.title,
        url: reference.url,
        text: reference.text,
        startLine: reference.startLine,
        endLine: reference.endLine,
      };
    },
    [resolveBrowserReference],
  );

  const openBrowserReference = useCallback(
    (rawUrl: string, label?: string) => {
      if (isHttpUrl(rawUrl)) {
        openBrowserUrl(rawUrl, label);
        return;
      }
      void resolveBrowserReference(rawUrl).then((reference) => {
        if (!reference) {
          return;
        }
        const tabId = openBrowserUrl(
          reference.url,
          reference.title ?? label ?? `Ref ${reference.refId}`,
        );
        if (!tabId) {
          return;
        }
        scheduleBrowserReferenceHighlight(tabId, reference);
      });
    },
    [openBrowserUrl, resolveBrowserReference, scheduleBrowserReferenceHighlight],
  );

  const handleBrowserBoundsChange = useCallback(
    (tabId: string, bounds: BrowserViewBounds) => {
      setBrowserBounds((prev) => ({ ...prev, [tabId]: bounds }));
      if (bounds.width <= 1 || bounds.height <= 1) {
        trpc.browserView.hideTab.mutate({ tabId }).catch(() => undefined);
        return;
      }
      const tab = browserTabMap.get(tabId);
      if (!tab) {
        return;
      }
      if (!openedBrowserTabsRef.current.has(tabId)) {
        trpc.browserView
          .open
          .mutate({
            tabId,
            url: tab.url,
            bounds,
          })
          .catch(() => undefined);
        openedBrowserTabsRef.current.add(tabId);
        return;
      }
      trpc.browserView
        .updateBounds
        .mutate({
          tabId,
          bounds,
        })
        .catch(() => undefined);
    },
    [browserTabMap],
  );

  const handleBrowserBack = useCallback((tabId: string) => {
    trpc.browserView.back.mutate({ tabId }).catch(() => undefined);
  }, []);

  const handleBrowserForward = useCallback((tabId: string) => {
    trpc.browserView.forward.mutate({ tabId }).catch(() => undefined);
  }, []);

  const handleBrowserReload = useCallback((tabId: string) => {
    trpc.browserView.reload.mutate({ tabId }).catch(() => undefined);
  }, []);

  const handleBrowserOpenExternal = useCallback((url: string) => {
    if (!isHttpUrl(url)) {
      return;
    }
    trpc.browserView.openExternal.mutate({ url }).catch(() => undefined);
  }, []);

  const handleBrowserNavigate = useCallback(
    (tabId: string, url: string) => {
      if (!isHttpUrl(url)) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url,
                title: undefined,
              }
            : tab,
        ),
      );
      const bounds = browserBounds[tabId];
      if (bounds) {
        trpc.browserView
          .open
          .mutate({
            tabId,
            url,
            bounds,
          })
          .catch(() => undefined);
        openedBrowserTabsRef.current.add(tabId);
      }
    },
    [browserBounds],
  );

  const handleInsertBrowserSelection = useCallback(
    (selection: BrowserViewSelection) => {
      const text = selection.text.trim();
      if (!text) {
        return;
      }
      const title = selection.title?.trim();
      const url = selection.url?.trim();
      const header = title ? `${title}` : url;
      const sourceLine = url ? `Source: ${url}` : "";
      const quoted = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `> ${line}`)
        .join("\n");
      const payload = [header, sourceLine, quoted].filter(Boolean).join("\n");
      setHistoryInput((prev) =>
        prev.trim().length > 0 ? `${prev.trimEnd()}\n\n${payload}\n` : `${payload}\n`,
      );
      setBrowserSelection(null);
      setChatScrollSignal((prev) => prev + 1);
    },
    [setBrowserSelection, setChatScrollSignal, setHistoryInput],
  );

  useEffect(() => {
    if (!saveEnabled) {
      return;
    }
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
            autoLayoutLocked,
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
  }, [autoLayoutLocked, chatMessages, edges, nodes, project.path, hydrated, saveEnabled]);

  const handleExit = () => {
    trpc.preview.hide.mutate().catch(() => undefined);
    onExit();
  };

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      openOrFocusTab("graph");
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
        suspendAutoLayoutForZoom(450);
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.05),
          duration: 400,
        });
      });
      setSelectedId(nodeId);
      setChatFocusSignal((prev) => prev + 1);
    },
    [
      flowInstance,
      getNode,
      nodes,
      openOrFocusTab,
      setNodes,
      setSelectedId,
      suspendAutoLayoutForZoom,
    ],
  );

  const handleNodeDoubleClick = useCallback(
    (_: MouseEvent, node: { id: string }) => {
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
        suspendAutoLayoutForZoom(520);
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.6),
          duration: 450,
        });
      });
      setSelectedId(node.id);
      setChatFocusSignal((prev) => prev + 1);
    },
    [flowInstance, getNode, setSelectedId, suspendAutoLayoutForZoom],
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
        suspendAutoLayoutForZoom(420);
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
        onRetry={retryMessage}
        retryMessageId={lastFailedMessageId}
        onFocusZoom={handleInputFocusZoom}
      />
    );
  };

  const renderTab = (tabId: string) => {
    const browserTabId = parseBrowserTabId(tabId);
    if (browserTabId) {
      const tab = browserTabMap.get(browserTabId);
      return (
        <BrowserTab
          tabId={browserTabId}
          url={tab?.url ?? ""}
          canGoBack={tab?.canGoBack}
          canGoForward={tab?.canGoForward}
          onBoundsChange={handleBrowserBoundsChange}
          onRequestBack={handleBrowserBack}
          onRequestForward={handleBrowserForward}
          onRequestReload={handleBrowserReload}
          onRequestOpenExternal={handleBrowserOpenExternal}
          onRequestNavigate={handleBrowserNavigate}
        />
      );
    }
    if (tabId === "chat" || tabId === CHAT_TAB_ID) {
      return (
        <ChatHistoryPanel
          messages={chatMessages}
          selectedResponseId={selectedResponseId}
          selectedNode={selectedNode}
          nodes={nodes}
          onFocusNode={handleFocusNode}
          onReferenceClick={openBrowserReference}
          onResolveReferencePreview={resolveReferencePreview}
          browserSelection={browserSelection}
          onInsertBrowserSelection={handleInsertBrowserSelection}
          scrollToBottomSignal={chatScrollSignal}
          focusSignal={chatFocusSignal}
          onRequestClearSelection={() => setSelectedId(null)}
          input={historyInput}
          busy={chatBusy}
          graphBusy={graphBusy}
          onInputChange={setHistoryInput}
          onSend={handleSendFromHistory}
          onRetry={retryMessage}
          lastFailedMessageId={lastFailedMessageId}
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
            nodesDraggable={!autoLayoutLocked}
            onInit={(instance) => {
              setFlowInstance(instance);
              const nextViewport = instance.getViewport();
              viewportRef.current = nextViewport;
              setViewport(nextViewport);
            }}
            onMove={(_, nextViewport) => {
              if (nextViewport.zoom !== viewportRef.current.zoom) {
                autoLayoutZoomingRef.current = true;
              }
              viewportRef.current = nextViewport;
              setViewport(nextViewport);
            }}
            onMoveStart={() => setIsDragging(true)}
            onMoveEnd={() => {
              setIsDragging(false);
              if (!autoLayoutZoomingRef.current) {
                return;
              }
              autoLayoutZoomingRef.current = false;
              if (autoLayoutZoomTimeoutRef.current) {
                window.clearTimeout(autoLayoutZoomTimeoutRef.current);
                autoLayoutZoomTimeoutRef.current = null;
              }
              if (!autoLayoutLocked) {
                autoLayoutPendingRef.current = false;
                return;
              }
              if (!autoLayoutPendingRef.current || isLayouting) {
                return;
              }
              autoLayoutPendingRef.current = false;
              void handleAutoLayout();
            }}
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
                  suspendAutoLayoutForZoom(420);
                  flowInstance.setViewport(viewport, { duration: 350 });
                });
              }
              if (flowInstance && nodeZoomRef.current) {
                const viewport = nodeZoomRef.current;
                nodeZoomRef.current = null;
                requestAnimationFrame(() => {
                  suspendAutoLayoutForZoom(420);
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
            deleteKeyCode={null}
            defaultEdgeOptions={{
              type: "smoothstep",
              style: { stroke: "var(--flow-edge)", strokeWidth: 1.6 },
            }}
            className="h-full w-full"
            fitView
          >
            <Background gap={20} size={1} color="var(--flow-grid)" />
            <Panel position="top-right" className="flex items-center gap-2">
              {!autoLayoutLocked ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 border-border/70 bg-card/80 text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
                  onClick={() => {
                    void handleAutoLayout();
                  }}
                  disabled={nodes.length === 0 || isLayouting}
                  aria-label="Run auto layout"
                  title="Run auto layout"
                >
                  <LayoutGrid />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="outline"
                className={`h-9 w-9 border-border/70 bg-card/80 text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground ${
                  autoLayoutLocked ? "border-primary/50 text-foreground" : ""
                }`}
                onClick={() => {
                  setAutoLayoutLocked((prev) => !prev);
                }}
                disabled={nodes.length === 0}
                aria-label={
                  autoLayoutLocked ? "Disable auto layout lock" : "Enable auto layout lock"
                }
                aria-pressed={autoLayoutLocked}
                title={
                  autoLayoutLocked ? "Auto layout locked" : "Auto layout unlocked"
                }
              >
                {autoLayoutLocked ? <Lock /> : <LockOpen />}
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
      const browserTabId = parseBrowserTabId(tabId);
      if (browserTabId) {
        const tab = browserTabMap.get(browserTabId);
        const resolvedLabel = normalizeBrowserLabel(tab?.title);
        const rawLabel =
          resolvedLabel ??
          (() => {
            if (!tab?.url) {
              return "Browser";
            }
            try {
              return new URL(tab.url).host;
            } catch {
              return tab.url;
            }
          })();
        const label = truncateLabel(rawLabel, BROWSER_TAB_MAX_LABEL_LENGTH);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[24ch] truncate text-sm font-medium text-foreground" title={rawLabel}>
              {label}
            </span>
          </div>
        );
      }
      if (tabId === "chat" || tabId === CHAT_TAB_ID) {
        return (
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground">Chat</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {chatMessages.length} MSG
            </span>
          </div>
        );
      }
      if (tabId === "graph" || tabId === GRAPH_TAB_ID) {
        return (
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground">Graph</span>
          </div>
        );
      }
      return <span className="text-sm font-medium text-foreground">{tabId}</span>;
    },
    [browserTabMap, chatMessages.length],
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
      <FlowWorkspaceLoader {...props} />
    </ReactFlowProvider>
  );
}
