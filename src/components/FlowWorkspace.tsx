import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
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
import type {
  IJsonModel,
  IJsonTabNode,
} from "@massbug/flexlayout-react";
import { Actions, DockLocation, Model } from "@massbug/flexlayout-react";
import { trpc } from "../lib/trpc";
import type { IpcRendererEvent } from "electron";
import QuestionNode from "./nodes/QuestionNode";
import SourceNode from "./nodes/SourceNode";
import InsightNode from "./nodes/InsightNode";
import SettingsPanel from "./SettingsPanel";
import { Button } from "@/components/ui/button";
import {
  Globe,
  LayoutGrid,
  LoaderCircle,
  Lock,
  LockOpen,
  LocateFixed,
  MessageSquare,
  Network,
} from "lucide-react";
import {
  buildRuntimeSettings,
  createProfileDraft,
  type ProviderProfile,
  type RuntimeSettingsPayload,
} from "../lib/settings";
import { getNodeSize } from "../lib/elkLayout";
import FlowHeader from "./flow/FlowHeader";
import FlowPanelInput from "./flow/FlowPanelInput";
import type {
  FlowWorkspaceProps,
  ProjectChatSummary,
  ProjectState,
} from "./flow/types";
import { useAutoLayout } from "./flow/useAutoLayout";
import { useFlowState } from "./flow/useFlowState";
import { useInitialFit } from "./flow/useInitialFit";
import { usePanelState } from "./flow/usePanelState";
import { usePreviewHover } from "./flow/usePreviewHover";
import { useProfileSettings } from "./flow/useProfileSettings";
import { useChatActions } from "./flow/useChatActions";
import { QuestionActionProvider } from "./flow/QuestionActionProvider";
import {
  executeBrowserValidation,
  updateBrowserTabValidationState,
} from "./flow/browserValidation";
import {
  isHttpUrl,
  normalizeBrowserLabel,
  normalizeHttpUrl,
  stripLineNumberPrefix,
  toReferenceHighlightPayload,
  truncateLabel,
} from "./flow/browser-utils";
import ChatHistoryPanel from "./chat/ChatHistoryPanel";
import type { InsightNodeData } from "../types/flow";
import type { ChatMessage } from "../types/chat";
import { FlowFlexLayout } from "./flow/FlowFlexLayout";
import { BrowserTab } from "./browser/BrowserTab";
import { ChatTabActions } from "./flow/ChatTabActions";
import type {
  BrowserPageValidationRecord,
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
import {
  listRunningChatIds,
  subscribeRunningChatJobs,
} from "@/lib/running-chat-jobs";
import {
  BROWSER_TAB_PREFIX,
  CHAT_TABSET_ID,
  CHAT_TAB_ID,
  GRAPH_TABSET_ID,
  GRAPH_TAB_ID,
  collectBrowserTabIds,
  collectVisibleBrowserTabIds,
  createDefaultLayoutModel,
  createSingleBrowserLayoutModel,
  createSingleTabLayoutModel,
  findFirstTabsetId,
  findTabsetIdContainingBrowserTab,
  findTabsetIdContainingGraph,
  hasTab,
  hasTabset,
  normalizeLayoutModel,
  parseBrowserTabId,
} from "./flow/flexlayout-utils";
import type { FlexLayoutNode } from "./flow/flexlayout-utils";

const BROWSER_TAB_MAX_LABEL_LENGTH = 36;
const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  style: { stroke: "var(--flow-edge)", strokeWidth: 1.6 },
} as const;

type ProjectStateInput = Omit<ProjectState, "chat"> & { chat?: ChatMessage[] };

const coerceProjectState = (state: ProjectStateInput): ProjectState => ({
  nodes: state.nodes,
  edges: state.edges,
  chat: state.chat ?? [],
  autoLayoutLocked:
    typeof state.autoLayoutLocked === "boolean" ? state.autoLayoutLocked : true,
  browserValidationByUrl: state.browserValidationByUrl ?? {},
});

const createEmptyProjectState = (): ProjectState => ({
  nodes: [],
  edges: [],
  chat: [],
  autoLayoutLocked: true,
  browserValidationByUrl: {},
});

const toTimestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortChatSummariesDesc = (
  chats: ProjectChatSummary[],
): ProjectChatSummary[] =>
  [...chats].sort(
    (left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  );

interface FlowWorkspaceSession {
  slotId: string;
  chatId: string | null;
  initialState: ProjectState;
}

const buildChatSlotId = (chatId: string): string => `chat:${chatId}`;
const buildDraftSlotId = (): string => `draft:${crypto.randomUUID()}`;

const applyRunningStatusToSummaries = (
  chats: ProjectChatSummary[],
  runningChatIds: Set<string>,
): ProjectChatSummary[] =>
  chats.map((chat) => ({
    ...chat,
    isRunning: Boolean(chat.isRunning) || runningChatIds.has(chat.id),
  }));

interface FlowWorkspaceInnerProps extends FlowWorkspaceProps {
  activeChatId: string | null;
  chatSummaries: ProjectChatSummary[];
  onSwitchChat: (chatId: string) => Promise<void>;
  onRenameChat: (chatId: string, title: string) => Promise<void>;
  onDeleteChat: (chatId: string) => Promise<void>;
  onCreateDraftChat: () => void;
  onPersistDraftChat: (payload: {
    firstQuestion: string;
    state: ProjectState;
    settings?: RuntimeSettingsPayload;
  }) => Promise<string | null>;
  onSavedChatUpdate: (chat: ProjectChatSummary | null) => void;
}

function FlowWorkspaceLoader(props: FlowWorkspaceProps) {
  const [sessions, setSessions] = useState<FlowWorkspaceSession[]>([]);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [chatSummaries, setChatSummaries] = useState<ProjectChatSummary[]>([]);
  const [runningChatIds, setRunningChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const lastPathRef = useRef<string | null>(null);
  const sessionsRef = useRef<FlowWorkspaceSession[]>([]);
  const activeSlotIdRef = useRef<string | null>(null);
  const saveEnabled = props.saveEnabled ?? true;
  const activeSession = useMemo(
    () => sessions.find((session) => session.slotId === activeSlotId) ?? null,
    [activeSlotId, sessions],
  );
  const activeChatId = activeSession?.chatId ?? null;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSlotIdRef.current = activeSlotId;
  }, [activeSlotId]);

  useEffect(() => {
    const refresh = () => {
      setRunningChatIds(listRunningChatIds(props.project.path));
    };
    refresh();
    return subscribeRunningChatJobs(refresh);
  }, [props.project.path]);

  useEffect(() => {
    let cancelled = false;
    const samePath = lastPathRef.current === props.project.path;
    lastPathRef.current = props.project.path;
    setLoading(true);
    if (!samePath) {
      setSessions([]);
      setActiveSlotId(null);
      setChatSummaries([]);
    }
    trpc.project.open
      .mutate({ path: props.project.path })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const resolvedChatId = result.activeChatId ?? null;
        const slotId = resolvedChatId
          ? buildChatSlotId(resolvedChatId)
          : buildDraftSlotId();
        setSessions([
          {
            slotId,
            chatId: resolvedChatId,
            initialState: coerceProjectState(result.state),
          },
        ]);
        setActiveSlotId(slotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(
              result.chats ?? [],
              listRunningChatIds(props.project.path),
            ),
          ),
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        const slotId = buildDraftSlotId();
        setSessions([
          {
            slotId,
            chatId: null,
            initialState: coerceProjectState(props.initialState),
          },
        ]);
        setActiveSlotId(slotId);
        setChatSummaries([]);
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

  const handleSwitchChat = useCallback(
    async (chatId: string) => {
      if (!chatId || chatId === activeChatId) {
        return;
      }
      const existing = sessionsRef.current.find(
        (session) => session.chatId === chatId,
      );
      if (existing) {
        setActiveSlotId(existing.slotId);
        return;
      }
      setLoading(true);
      try {
        const result = await trpc.project.openChat.mutate({
          path: props.project.path,
          chatId,
        });
        const slotId = buildChatSlotId(result.chatId);
        setSessions((previous) => {
          if (previous.some((session) => session.chatId === result.chatId)) {
            return previous;
          }
          return [
            ...previous,
            {
              slotId,
              chatId: result.chatId,
              initialState: coerceProjectState(result.state),
            },
          ];
        });
        setActiveSlotId(slotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [activeChatId, props.project.path, runningChatIds],
  );

  const handleCreateDraftChat = useCallback(() => {
    const existingDraft = sessionsRef.current.find(
      (session) => session.chatId === null,
    );
    if (existingDraft) {
      setActiveSlotId(existingDraft.slotId);
      return;
    }
    const slotId = buildDraftSlotId();
    setSessions((previous) => [
      ...previous,
      {
        slotId,
        chatId: null,
        initialState: createEmptyProjectState(),
      },
    ]);
    setActiveSlotId(slotId);
  }, []);

  const handlePersistDraftChat = useCallback(
    async ({
      firstQuestion,
      state,
      settings,
    }: {
      firstQuestion: string;
      state: ProjectState;
      settings?: RuntimeSettingsPayload;
    }) => {
      if (activeSession?.chatId) {
        return activeSession.chatId;
      }
      const result = await trpc.project.createChat.mutate({
        path: props.project.path,
        firstQuestion,
        settings,
        state: {
          version: 1,
          nodes: state.nodes,
          edges: state.edges,
          chat: state.chat,
          autoLayoutLocked: state.autoLayoutLocked,
          browserValidationByUrl: state.browserValidationByUrl,
        },
      });
      const nextChatId = result.activeChatId ?? result.chat.id;
      const targetSlotId = activeSlotIdRef.current;
      setSessions((previous) => {
        if (!targetSlotId) {
          return previous;
        }
        return previous.map((session) =>
          session.slotId === targetSlotId
            ? { ...session, chatId: nextChatId }
            : session,
        );
      });
      setChatSummaries(
        sortChatSummariesDesc(
          applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
        ),
      );
      return nextChatId;
    },
    [activeSession, props.project.path, runningChatIds],
  );
  const handleRenameChat = useCallback(
    async (chatId: string, title: string) => {
      const result = await trpc.project.renameChat.mutate({
        path: props.project.path,
        chatId,
        title,
      });
      setChatSummaries(
        sortChatSummariesDesc(
          applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
        ),
      );
      const nextActiveChatId = result.activeChatId ?? null;
      if (!nextActiveChatId) {
        return;
      }
      const existing = sessionsRef.current.find(
        (session) => session.chatId === nextActiveChatId,
      );
      if (existing) {
        setActiveSlotId(existing.slotId);
      }
    },
    [props.project.path, runningChatIds],
  );
  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      setLoading(true);
      try {
        const result = await trpc.project.deleteChat.mutate({
          path: props.project.path,
          chatId,
        });
        const nextActiveChatId = result.activeChatId ?? null;
        const stateFromServer = coerceProjectState(result.state);
        const filtered = sessionsRef.current.filter(
          (session) => session.chatId !== chatId,
        );
        let nextSessions = filtered;
        let nextSlotId: string | null = null;
        if (!nextActiveChatId) {
          const draft = filtered.find((session) => session.chatId === null);
          if (draft) {
            nextSlotId = draft.slotId;
          } else {
            const draftSlotId = buildDraftSlotId();
            nextSessions = [
              ...filtered,
              {
                slotId: draftSlotId,
                chatId: null,
                initialState: stateFromServer,
              },
            ];
            nextSlotId = draftSlotId;
          }
        } else {
          const existing = filtered.find(
            (session) => session.chatId === nextActiveChatId,
          );
          if (existing) {
            nextSlotId = existing.slotId;
          } else {
            const slotId = buildChatSlotId(nextActiveChatId);
            nextSessions = [
              ...filtered,
              {
                slotId,
                chatId: nextActiveChatId,
                initialState: stateFromServer,
              },
            ];
            nextSlotId = slotId;
          }
        }
        setSessions(nextSessions);
        setActiveSlotId(nextSlotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [props.project.path, runningChatIds],
  );

  const handleSavedChatUpdate = useCallback(
    (chat: ProjectChatSummary | null) => {
      if (!chat) {
        return;
      }
      setSessions((previous) => {
        const alreadyBound = previous.some((session) => session.chatId === chat.id);
        if (alreadyBound) {
          return previous;
        }
        const firstDraft = previous.find((session) => session.chatId === null);
        if (!firstDraft) {
          return previous;
        }
        return previous.map((session) =>
          session.slotId === firstDraft.slotId
            ? { ...session, chatId: chat.id }
            : session,
        );
      });
      setChatSummaries((prev) =>
        sortChatSummariesDesc([
          {
            ...chat,
            isRunning: Boolean(chat.isRunning) || runningChatIds.has(chat.id),
          },
          ...prev.filter((item) => item.id !== chat.id),
        ]),
      );
    },
    [runningChatIds],
  );

  useEffect(() => {
    setChatSummaries((prev) =>
      sortChatSummariesDesc(applyRunningStatusToSummaries(prev, runningChatIds)),
    );
  }, [runningChatIds]);

  if (loading && sessions.length === 0) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <div className="rounded-xl border border-border/70 bg-card/80 px-6 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
          Reloading project...
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="relative h-screen w-screen">
      {sessions.map((session) => (
        <div
          key={session.slotId}
          className={session.slotId === activeSlotId ? "absolute inset-0" : "hidden"}
        >
          <FlowWorkspaceInner
            {...props}
            initialState={session.initialState}
            activeChatId={session.chatId}
            chatSummaries={chatSummaries}
            onSwitchChat={handleSwitchChat}
            onRenameChat={handleRenameChat}
            onDeleteChat={handleDeleteChat}
            onCreateDraftChat={handleCreateDraftChat}
            onPersistDraftChat={handlePersistDraftChat}
            onSavedChatUpdate={handleSavedChatUpdate}
            saveEnabled={saveEnabled}
          />
        </div>
      ))}
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
  activeChatId,
  chatSummaries,
  onSwitchChat,
  onRenameChat,
  onDeleteChat,
  onCreateDraftChat,
  onPersistDraftChat,
  onSavedChatUpdate,
  theme,
  onToggleTheme,
  onExit,
  saveEnabled = true,
}: FlowWorkspaceInnerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [sessionChatId, setSessionChatId] = useState<string | null>(activeChatId);
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
  const [browserValidationByUrl, setBrowserValidationByUrl] = useState<
    Record<string, BrowserPageValidationRecord>
  >(() => initialState.browserValidationByUrl ?? {});
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
  const projectTitleClickTimestampsRef = useRef<number[]>([]);
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

  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    hydrated,
  } = useFlowState(initialState);
  useEffect(() => {
    setSessionChatId(activeChatId);
  }, [activeChatId]);
  const {
    profiles,
    setProfiles,
    activeProfileId,
    setActiveProfileId,
    activeProfile,
  } = useProfileSettings(project.path);
  const { panelVisible, panelNodeId } = usePanelState(selectedId, isDragging);
  const displayEdges = useMemo(() => edges, [edges]);
  const runtimeSettings = useMemo(
    () => buildRuntimeSettings(activeProfile),
    [activeProfile],
  );
  const prefersCdpBrowser = activeProfile?.browserDisplayMode === "cdp";
  const persistDraftChatBeforeSend = useCallback(
    async (prompt: string) => {
      if (sessionChatId) {
        return;
      }
      const nextChatId = await onPersistDraftChat({
        firstQuestion: prompt,
        settings: runtimeSettings,
        state: {
          nodes,
          edges,
          chat: [],
          autoLayoutLocked,
          browserValidationByUrl,
        },
      });
      if (nextChatId) {
        setSessionChatId(nextChatId);
      }
    },
    [
      autoLayoutLocked,
      browserValidationByUrl,
      edges,
      nodes,
      onPersistDraftChat,
      runtimeSettings,
      sessionChatId,
    ],
  );
  const {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    deepResearchConfig,
    setDeepResearchConfig,
    graphGenerationEnabled,
    setGraphGenerationEnabled,
    messages: chatMessages,
    busy,
    chatBusy,
    graphBusy,
    retryMessage,
    handleSendFromHistory,
    handleSendFromPanel,
    stopChatGeneration,
  } = useChatActions({
    projectPath: project.path,
    chatId: sessionChatId,
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedId,
    flowInstance,
    activeProfile,
    initialMessages: initialState.chat ?? [],
    onBeforeSendPrompt: persistDraftChatBeforeSend,
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
          {
            if (tab.id !== payload.tabId) {
              return tab;
            }
            const nextUrl = payload.url ?? tab.url;
            const urlChanged = nextUrl !== tab.url;
            return {
              ...tab,
              url: nextUrl,
              title: payload.title ?? tab.title,
              canGoBack: payload.canGoBack ?? tab.canGoBack,
              canGoForward: payload.canGoForward ?? tab.canGoForward,
              isLoading: payload.isLoading ?? tab.isLoading,
              validationStatus: urlChanged ? undefined : tab.validationStatus,
              validationError: urlChanged ? undefined : tab.validationError,
            };
          },
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
    (
      rawUrl: string,
      label?: string,
      referenceHighlight?: BrowserViewReferenceHighlight,
    ): string | null => {
      const normalized = normalizeHttpUrl(rawUrl);
      if (!normalized) {
        return null;
      }
      const existing = browserTabs.find((tab) => tab.url === normalized);
      if (existing) {
        setBrowserTabs((prev) =>
          prev.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  referenceHighlight,
                }
              : tab,
          ),
        );
        selectBrowserTab(existing.id);
        return existing.id;
      }

      const tabId = `browser-${crypto.randomUUID()}`;
      const resolvedLabel = normalizeBrowserLabel(label);
      const nextTab: BrowserViewTabState = {
        id: tabId,
        url: normalized,
        title: resolvedLabel,
        isLoading: true,
        referenceHighlight,
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

      const firstBrowserTabId = browserTabs[0]?.id ?? null;
      const targetTabsetId = firstBrowserTabId
        ? findTabsetIdContainingBrowserTab(layout, firstBrowserTabId) ??
          findTabsetIdContainingGraph(layout)
        : findTabsetIdContainingGraph(layout);
      if (targetTabsetId && hasTabset(layout, targetTabsetId)) {
        model.doAction(
          Actions.addNode(tab, targetTabsetId, DockLocation.CENTER, -1, true),
        );
        handleLayoutChange(model.toJson());
        return tabId;
      }

      const fallbackTabsetId = findFirstTabsetId(layout);
      if (!fallbackTabsetId) {
        handleLayoutChange(createSingleBrowserLayoutModel(tabId, resolvedLabel));
        return tabId;
      }
      model.doAction(
        Actions.addNode(tab, fallbackTabsetId, DockLocation.CENTER, -1, true),
      );
      handleLayoutChange(model.toJson());
      return tabId;
    },
    [browserTabs, handleLayoutChange, layoutModel, selectBrowserTab],
  );

  const scheduleBrowserReferenceHighlight = useCallback(
    (
      tabId: string,
      reference: BrowserViewReferenceHighlight,
      attempt = 0,
    ) => {
      if (attempt > 8) {
        return;
      }
      const delay = attempt === 0 ? 180 : Math.min(1300, 220 * (attempt + 1));
      const timerId = window.setTimeout(() => {
        browserHighlightTimersRef.current.delete(timerId);
        trpc.browserView.highlightReference
          .mutate({
            tabId,
            reference,
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
        text: stripLineNumberPrefix(reference.text),
        startLine: reference.startLine,
        endLine: reference.endLine,
        validationRefContent: reference.validationRefContent,
        accuracy: reference.accuracy,
        issueReason: reference.issueReason,
        correctFact: reference.correctFact,
      };
    },
    [resolveBrowserReference],
  );

  const openCdpUrl = useCallback(
    (
      url: string,
      reference?: BrowserViewReferenceHighlight,
    ) => {
      const normalizedUrl = normalizeHttpUrl(url);
      if (!normalizedUrl) {
        return;
      }
      trpc.cdpBrowser.open
        .mutate({
          url: normalizedUrl,
          reference,
        })
        .catch(() => undefined);
    },
    [],
  );

  const openBrowserReference = useCallback(
    (rawUrl: string, label?: string) => {
      if (prefersCdpBrowser) {
        if (isHttpUrl(rawUrl)) {
          openCdpUrl(rawUrl);
          return;
        }
        void resolveBrowserReference(rawUrl).then((reference) => {
          if (!reference) {
            return;
          }
          const highlight = toReferenceHighlightPayload(reference);
          openCdpUrl(reference.url, highlight);
        });
        return;
      }
      if (isHttpUrl(rawUrl)) {
        openBrowserUrl(rawUrl, label);
        return;
      }
      void resolveBrowserReference(rawUrl).then((reference) => {
        if (!reference) {
          return;
        }
        const highlight = toReferenceHighlightPayload(reference);
        const tabId = openBrowserUrl(
          reference.url,
          reference.title ?? label ?? `Ref ${reference.refId}`,
          highlight,
        );
        if (!tabId) {
          return;
        }
        scheduleBrowserReferenceHighlight(tabId, highlight);
      });
    },
    [
      openBrowserUrl,
      openCdpUrl,
      prefersCdpBrowser,
      resolveBrowserReference,
      scheduleBrowserReferenceHighlight,
    ],
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

  const handleBrowserOpenCdp = useCallback(
    (tabId: string, url: string) => {
      const tab = browserTabMap.get(tabId);
      openCdpUrl(url, tab?.referenceHighlight);
    },
    [browserTabMap, openCdpUrl],
  );

  const handleBrowserValidate = useCallback(
    async (tabId: string) => {
      const tab = browserTabMap.get(tabId);
      if (!tab) {
        return;
      }
      const normalizedTabUrl = normalizeHttpUrl(tab.url);
      if (!normalizedTabUrl) {
        return;
      }
      setBrowserTabs((prev) =>
        updateBrowserTabValidationState({
          tabs: prev,
          tabId,
          status: "running",
        }),
      );
      try {
        const { resolvedPageUrl, record } = await executeBrowserValidation({
          tab,
          normalizedTabUrl,
          projectPath: project.path,
          runtimeSettings,
          deepResearchConfig,
          captureValidationSnapshot: () =>
            trpc.browserView.captureValidationSnapshot.mutate({ tabId }),
          validateAnswer: (input) => trpc.chat.validate.mutate(input),
        });
        setBrowserValidationByUrl((prev) => ({
          ...prev,
          [resolvedPageUrl]: record,
        }));
        setBrowserTabs((prev) =>
          updateBrowserTabValidationState({
            tabs: prev,
            tabId,
            status: "complete",
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Page validation failed";
        setBrowserTabs((prev) =>
          updateBrowserTabValidationState({
            tabs: prev,
            tabId,
            status: "failed",
            error: message,
          }),
        );
      }
    },
    [
      browserTabMap,
      deepResearchConfig,
      project.path,
      runtimeSettings,
    ],
  );

  const handleBrowserNavigate = useCallback(
    (tabId: string, url: string) => {
      const normalizedUrl = normalizeHttpUrl(url);
      if (!normalizedUrl) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: normalizedUrl,
                title: undefined,
                isLoading: true,
                referenceHighlight: undefined,
                validationStatus: undefined,
                validationError: undefined,
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
            url: normalizedUrl,
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
    if (!sessionChatId) {
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
          chatId: sessionChatId,
          state: {
            nodes,
            edges,
            chat: chatMessages,
            autoLayoutLocked,
            browserValidationByUrl,
            version: 1,
          },
        })
        .then((result) => {
          onSavedChatUpdate(result.chat);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [
    autoLayoutLocked,
    browserValidationByUrl,
    chatMessages,
    edges,
    hydrated,
    nodes,
    onSavedChatUpdate,
    project.path,
    saveEnabled,
    sessionChatId,
  ]);

  const handleExit = useCallback(() => {
    trpc.preview.hide.mutate().catch(() => undefined);
    onExit();
  }, [onExit]);

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
  const handleRequestClearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);
  const handleFlowInit = useCallback((instance: ReactFlowInstance) => {
    setFlowInstance(instance);
    const nextViewport = instance.getViewport();
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);
  const handleFlowMove = useCallback((_: unknown, nextViewport: Viewport) => {
    if (nextViewport.zoom !== viewportRef.current.zoom) {
      autoLayoutZoomingRef.current = true;
    }
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);
  const handleFlowMoveStart = useCallback(() => {
    setIsDragging(true);
  }, []);
  const handleFlowMoveEnd = useCallback(() => {
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
  }, [autoLayoutLocked, handleAutoLayout, isLayouting]);
  const handleFlowNodeClick = useCallback(
    (_: unknown, node: { id: string }) => {
      setSelectedId(node.id);
      setPanelInput("");
      setChatFocusSignal((prev) => prev + 1);
    },
    [setPanelInput],
  );
  const handleFlowPaneClick = useCallback(() => {
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
  }, [flowInstance, suspendAutoLayoutForZoom]);
  const handleFlowNodeDragStart = useCallback(() => {
    setIsDragging(true);
  }, []);
  const handleFlowNodeDragStop = useCallback(() => {
    setIsDragging(false);
  }, []);

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
        onStop={stopChatGeneration}
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
      const normalizedTabUrl = tab ? normalizeHttpUrl(tab.url) : null;
      const validation =
        normalizedTabUrl !== null
          ? browserValidationByUrl[normalizedTabUrl]
          : undefined;
      return (
        <BrowserTab
          tabId={browserTabId}
          url={tab?.url ?? ""}
          canGoBack={tab?.canGoBack}
          canGoForward={tab?.canGoForward}
          validation={validation}
          validationStatus={tab?.validationStatus}
          validationError={tab?.validationError}
          onBoundsChange={handleBrowserBoundsChange}
          onRequestBack={handleBrowserBack}
          onRequestForward={handleBrowserForward}
          onRequestReload={handleBrowserReload}
          onRequestValidate={handleBrowserValidate}
          onRequestOpenCdp={handleBrowserOpenCdp}
          onRequestOpenExternal={handleBrowserOpenExternal}
          onRequestNavigate={handleBrowserNavigate}
        />
      );
    }
    if (tabId === "chat" || tabId === CHAT_TAB_ID) {
      return (
        <ChatHistoryPanel
          developerMode={developerMode}
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
          onRequestClearSelection={handleRequestClearSelection}
          input={historyInput}
          deepResearchConfig={deepResearchConfig}
          onDeepResearchConfigChange={setDeepResearchConfig}
          graphGenerationEnabled={graphGenerationEnabled}
          onGraphGenerationEnabledChange={setGraphGenerationEnabled}
          busy={chatBusy}
          graphBusy={graphBusy}
          onInputChange={setHistoryInput}
          onSend={handleSendFromHistory}
          onStop={stopChatGeneration}
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
            onInit={handleFlowInit}
            onMove={handleFlowMove}
            onMoveStart={handleFlowMoveStart}
            onMoveEnd={handleFlowMoveEnd}
            onNodeClick={handleFlowNodeClick}
            selectNodesOnDrag={false}
            onPaneClick={handleFlowPaneClick}
            onNodeDragStart={handleFlowNodeDragStart}
            onNodeDragStop={handleFlowNodeDragStop}
            onNodeMouseEnter={handleNodeEnter}
            onNodeMouseLeave={handleNodeLeave}
            onNodeDoubleClick={handleNodeDoubleClick}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
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
  const handleSwitchChatAction = useCallback(
    (chatId: string) => {
      void onSwitchChat(chatId);
    },
    [onSwitchChat],
  );
  const handleRenameChatAction = useCallback(
    (chatId: string, title: string) => {
      void onRenameChat(chatId, title);
    },
    [onRenameChat],
  );
  const handleDeleteChatAction = useCallback(
    (chatId: string) => {
      void onDeleteChat(chatId);
    },
    [onDeleteChat],
  );

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
            {tab?.isLoading ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
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
            <ChatTabActions
              chats={chatSummaries}
              activeChatId={sessionChatId}
              busy={busy}
              onSwitchChat={handleSwitchChatAction}
              onRenameChat={handleRenameChatAction}
              onDeleteChat={handleDeleteChatAction}
              onCreateChat={onCreateDraftChat}
            />
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
    [
      browserTabMap,
      busy,
      chatMessages.length,
      chatSummaries,
      handleDeleteChatAction,
      handleRenameChatAction,
      handleSwitchChatAction,
      onCreateDraftChat,
      sessionChatId,
    ],
  );

  const renderTabButtons = useCallback(
    (tabId: string) => {
      const browserTabId = parseBrowserTabId(tabId);
      if (!browserTabId) {
        return null;
      }
      const tab = browserTabMap.get(browserTabId);
      const reference = tab?.referenceHighlight;
      if (!reference) {
        return null;
      }
      const stopTabHeaderEvent = (event: SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };
      return [
        <button
          key={`${browserTabId}-refocus-reference`}
          type="button"
          className="flexlayout__tab_button_trailing"
          title="Scroll and highlight reference"
          aria-label="Scroll and highlight reference"
          onMouseDown={(event) => {
            stopTabHeaderEvent(event);
          }}
          onClick={(event) => {
            stopTabHeaderEvent(event);
            selectBrowserTab(browserTabId);
            scheduleBrowserReferenceHighlight(browserTabId, reference);
          }}
        >
          <LocateFixed className="h-3.5 w-3.5" />
        </button>,
      ];
    },
    [browserTabMap, scheduleBrowserReferenceHighlight, selectBrowserTab],
  );

  const handleProjectNameClick = useCallback(() => {
    const now = Date.now();
    const windowMs = 2000;
    const requiredClicks = 5;
    const recent = projectTitleClickTimestampsRef.current.filter(
      (timestamp) => now - timestamp <= windowMs,
    );
    recent.push(now);
    projectTitleClickTimestampsRef.current = recent;
    if (recent.length >= requiredClicks) {
      setDeveloperMode((previous) => !previous);
      projectTitleClickTimestampsRef.current = [];
    }
  }, []);
  const questionActionValue = useMemo(
    () => ({ retryQuestion, busy }),
    [retryQuestion, busy],
  );
  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);
  const handleFocusChat = useCallback(() => {
    openOrFocusTab("chat");
  }, [openOrFocusTab]);
  const handleFocusGraph = useCallback(() => {
    openOrFocusTab("graph");
  }, [openOrFocusTab]);
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const handleActiveProfileChange = useCallback((id: string) => {
    setActiveProfileId(id);
  }, [setActiveProfileId]);
  const handleProfileAdd = useCallback(() => {
    setProfiles((prev) => {
      const nextIndex = prev.length + 1;
      return [...prev, createProfileDraft(`Profile ${nextIndex}`)];
    });
  }, [setProfiles]);
  const handleProfileDelete = useCallback(
    (id: string) => {
      setProfiles((prev) => {
        const next = prev.filter((profile) => profile.id !== id);
        if (activeProfileId === id) {
          setActiveProfileId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [activeProfileId, setActiveProfileId, setProfiles],
  );
  const handleProfileChange = useCallback(
    (id: string, patch: Partial<ProviderProfile>) => {
      setProfiles((prev) =>
        prev.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile,
        ),
      );
    },
    [setProfiles],
  );


  return (
    <QuestionActionProvider value={questionActionValue}>
      <div className="flex h-screen w-screen flex-col bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <FlowHeader
          projectName={project.name}
          projectPath={project.path}
          developerMode={developerMode}
          busy={busy}
          onProjectNameClick={handleProjectNameClick}
          onOpenSettings={handleOpenSettings}
          onFocusChat={handleFocusChat}
          onFocusGraph={handleFocusGraph}
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
            renderTabButtons={renderTabButtons}
          />
        </div>
        <SettingsPanel
          open={settingsOpen}
          profiles={profiles}
          activeProfileId={activeProfileId}
          onClose={handleCloseSettings}
          onActiveProfileChange={handleActiveProfileChange}
          onProfileAdd={handleProfileAdd}
          onProfileDelete={handleProfileDelete}
          onProfileChange={handleProfileChange}
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
