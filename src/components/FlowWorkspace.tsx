import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type ReactFlowInstance,
  type Viewport,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { trpc } from "../lib/trpc";
import QuestionNode from "./nodes/QuestionNode";
import SourceNode from "./nodes/SourceNode";
import type {
  FlowEdge,
  FlowNode,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../types/flow";
import SettingsPanel from "./SettingsPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  QUESTION_NODE_HEIGHT,
  QUESTION_NODE_WIDTH,
  SOURCE_NODE_HEIGHT,
  SOURCE_NODE_WIDTH,
  layoutQuestionWithElk,
  layoutSourcesWithElk,
  resolveRightBiasedPosition,
} from "../lib/elkLayout";
import {
  createProfileDraft,
  ensureActiveProfileId,
  loadActiveProfileId,
  loadProfiles,
  saveActiveProfileId,
  saveProfiles,
  type ProviderProfile,
} from "../lib/settings";

type ProjectState = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

type ProjectInfo = {
  path: string;
  name: string;
};

type FlowWorkspaceProps = {
  project: ProjectInfo;
  initialState: ProjectState;
  onExit: () => void;
};

export default function FlowWorkspace({
  project,
  initialState,
  onExit,
}: FlowWorkspaceProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    initialState.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialState.edges,
  );
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() =>
    loadProfiles(),
  );
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    loadActiveProfileId(project.path),
  );
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const lastQuestionId = useRef<string | null>(null);
  const hydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const initialFitDone = useRef(false);
  const panelHideTimer = useRef<number | null>(null);

  const nodeTypes = useMemo(
    () => ({ question: QuestionNode, source: SourceNode }),
    [],
  );
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  useEffect(() => {
    const loadedProfiles = loadProfiles();
    const loadedActiveId = loadActiveProfileId(project.path);
    setProfiles(loadedProfiles);
    setActiveProfileId(
      ensureActiveProfileId(project.path, loadedProfiles, loadedActiveId),
    );
  }, [project.path]);

  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    saveActiveProfileId(project.path, activeProfileId);
  }, [activeProfileId, project.path]);

  useEffect(() => {
    if (!selectedId) {
      setPanelVisible(false);
      return;
    }
    setPanelNodeId(selectedId);
    setPanelVisible(false);
    const id = window.requestAnimationFrame(() => setPanelVisible(true));
    return () => window.cancelAnimationFrame(id);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId && !panelVisible && panelNodeId) {
      if (panelHideTimer.current) {
        window.clearTimeout(panelHideTimer.current);
      }
      panelHideTimer.current = window.setTimeout(() => {
        setPanelNodeId(null);
      }, 300);
      return () => {
        if (panelHideTimer.current) {
          window.clearTimeout(panelHideTimer.current);
        }
      };
    }
    return () => undefined;
  }, [panelNodeId, panelVisible, selectedId]);

  useEffect(() => {
    if (isDragging) {
      setPanelVisible(false);
      return;
    }
    if (selectedId) {
      setPanelVisible(false);
      const id = window.requestAnimationFrame(() => setPanelVisible(true));
      return () => window.cancelAnimationFrame(id);
    }
    return () => undefined;
  }, [isDragging, selectedId]);

  useEffect(() => {
    if (initialState.nodes.length === 0) {
      const rootId = crypto.randomUUID();
      const rootNode: QuestionNodeType = {
        id: rootId,
        type: "question",
        position: { x: 0, y: 0 },
        data: {
          question: "Start here",
          answer: "Select this node to ask your first question.",
        },
        width: QUESTION_NODE_WIDTH,
      };
      setNodes([rootNode]);
      setEdges([]);
      lastQuestionId.current = rootId;
      setSelectedId(rootId);
      trpc.project.saveState
        .mutate({
          path: project.path,
          state: {
            nodes: [rootNode],
            edges: [],
            version: 1,
          },
        })
        .catch(() => undefined);
    } else {
      setNodes(initialState.nodes);
      setEdges(initialState.edges);
      const lastQuestion = [...initialState.nodes]
        .filter((node) => node.type === "question")
        .slice(-1)[0];
      lastQuestionId.current = lastQuestion?.id ?? null;
    }
    hydrated.current = true;
  }, [initialState.edges, initialState.nodes, setEdges, setNodes]);

  useEffect(() => {
    if (!flowInstance || initialFitDone.current || nodes.length === 0) {
      return;
    }
    initialFitDone.current = true;
    requestAnimationFrame(() => {
      flowInstance.fitView({ padding: 0.2, duration: 400 });
    });
  }, [flowInstance, nodes.length]);

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
  }, [nodes, edges, project.path]);

  const buildContextPath = useCallback(
    (targetId: string) => {
      const visited = new Set<string>();
      const pathNodes: FlowNode[] = [];
      let currentId: string | null = targetId;

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const currentNode = nodes.find((node) => node.id === currentId);
        if (!currentNode) {
          break;
        }
        pathNodes.push(currentNode);
        const parentEdge = edges.find((edge) => edge.target === currentId);
        currentId = parentEdge?.source ?? null;
      }

      return pathNodes.reverse();
    },
    [edges, nodes],
  );

  const buildContextSummary = useCallback(
    (targetId: string) => {
      const path = buildContextPath(targetId);
      if (path.length === 0) {
        return "";
      }
      return path
        .map((node) => {
          if (node.type === "question") {
            const data = node.data as QuestionNodeType["data"];
            return `Q: ${data.question}\nA: ${data.answer}`;
          }
          if (node.type === "source") {
            const data = node.data as SourceNodeType["data"];
            return `Source: ${data.title}\n${data.url}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    },
    [buildContextPath],
  );

  const handleAsk = useCallback(async () => {
    if (!prompt.trim() || busy || !selectedId) {
      return;
    }
    const questionText = prompt.trim();
    setPrompt("");
    setBusy(true);

    const parentNode = nodes.find((node) => node.id === selectedId) ?? null;
    const parentPosition = parentNode?.position ?? { x: 0, y: 0 };

    const questionId = crypto.randomUUID();
    const elkQuestionPosition = await layoutQuestionWithElk({
      parent: parentNode,
      parentPosition,
      questionId,
    });
    const questionPosition = resolveRightBiasedPosition({
      desired: elkQuestionPosition,
      nodes,
      size: { width: QUESTION_NODE_WIDTH, height: QUESTION_NODE_HEIGHT },
    });
    const questionNode: QuestionNodeType = {
      id: questionId,
      type: "question",
      position: questionPosition,
      data: {
        question: questionText,
        answer: "Searching and reasoning...",
      },
      width: QUESTION_NODE_WIDTH,
    };

    setNodes((prev: FlowNode[]) => [...prev, questionNode]);
    if (selectedId) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: selectedId,
          target: questionId,
          type: "smoothstep",
        },
      ]);
    } else if (lastQuestionId.current) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: lastQuestionId.current,
          target: questionId,
          type: "smoothstep",
        },
      ]);
    }
    lastQuestionId.current = questionId;
    setSelectedId(questionId);

    try {
      const context = selectedId ? buildContextSummary(selectedId) : "";
      const result = await trpc.deepSearch.run.mutate({
        projectPath: project.path,
        query: questionText,
        maxResults: 5,
        context,
        settings: activeProfile
          ? {
              tavilyApiKey: activeProfile.tavilyApiKey.trim() || undefined,
              jinaReaderBaseUrl:
                activeProfile.jinaReaderBaseUrl.trim() || undefined,
              llmProvider: activeProfile.llmProvider.trim() || undefined,
              llmModelId: activeProfile.llmModelId.trim() || undefined,
              llmApiKey: activeProfile.llmApiKey.trim() || undefined,
              llmBaseUrl: activeProfile.llmBaseUrl.trim() || undefined,
            }
          : undefined,
      });

      const elkSourcePositions = await layoutSourcesWithElk({
        questionPosition,
        questionId,
        sourceIds: result.sources.map((source) => source.id),
      });
      const placedNodes: FlowNode[] = [
        ...nodes,
        {
          id: questionId,
          type: "question",
          position: questionPosition,
          data: { question: questionText, answer: "" },
          width: QUESTION_NODE_WIDTH,
        },
      ];
      const sourcePositions = elkSourcePositions.map((position, index) => {
        const resolved = resolveRightBiasedPosition({
          desired: position,
          nodes: placedNodes,
          size: { width: SOURCE_NODE_WIDTH, height: SOURCE_NODE_HEIGHT },
        });
        placedNodes.push({
          id: `__placed_${index}`,
          type: "source",
          position: resolved,
          data: { title: "", url: "" },
          width: SOURCE_NODE_WIDTH,
        });
        return resolved;
      });
      const sourceNodes: SourceNodeType[] = result.sources.map(
        (source, index) => ({
          id: source.id,
          type: "source",
          position: sourcePositions[index],
          data: {
            title: source.title,
            url: source.url,
            snippet: source.snippet,
          },
          width: SOURCE_NODE_WIDTH,
        }),
      );

      setNodes((prev: FlowNode[]) =>
        prev
          .map((node) => {
            if (node.id === questionId && node.type === "question") {
              return {
                ...node,
                data: {
                  ...node.data,
                  answer: result.answer,
                },
              };
            }
            return node;
          })
          .concat(sourceNodes),
      );

      const sourceEdges: FlowEdge[] = result.sources.map((source) => ({
        id: crypto.randomUUID(),
        source: questionId,
        target: source.id,
        type: "smoothstep",
      }));
      setEdges((prev: FlowEdge[]) => [...prev, ...sourceEdges]);

      requestAnimationFrame(() => {
        flowInstance?.fitView({ padding: 0.2, duration: 400 });
      });
    } catch (error) {
      setNodes((prev: FlowNode[]) =>
        prev.map((node) => {
          if (node.id === questionId && node.type === "question") {
            return {
              ...node,
              data: {
                ...node.data,
                answer: "Request failed. Please try again.",
              },
            };
          }
          return node;
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [
    activeProfile,
    busy,
    flowInstance,
    nodes,
    project.path,
    prompt,
    setEdges,
    setNodes,
  ]);

  const handleNodeEnter = useCallback((_: unknown, node: FlowNode) => {
    if (node.type !== "source") {
      return;
    }
    const data = node.data;
    if (!data?.url) {
      return;
    }
    const width = Math.min(window.innerWidth * 0.6, 980);
    const height = Math.min(window.innerHeight * 0.65, 720);
    const x = window.innerWidth - width - 24;
    const y = 24;
    trpc.preview.show
      .mutate({
        url: data.url,
        bounds: { x, y, width, height },
      })
      .catch(() => undefined);
  }, []);

  const handleNodeLeave = useCallback(() => {
    trpc.preview.hide.mutate().catch(() => undefined);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-6 border-b border-white/10 bg-slate-950/80 px-8 py-5 backdrop-blur">
        <div>
          <div className="text-lg font-semibold text-white">{project.name}</div>
          <div className="text-xs text-white/50">{project.path}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
          <Button
            variant="outline"
            className="border-white/15 bg-transparent text-xs uppercase tracking-[0.2em] text-white/80 hover:border-white/30 hover:bg-white/5"
            onClick={() => {
              trpc.preview.hide.mutate().catch(() => undefined);
              onExit();
            }}
            disabled={busy}
          >
            Switch project
          </Button>
        </div>
      </header>
      <div className="relative flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
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
            setPrompt("");
          }}
          onPaneClick={() => setSelectedId(null)}
          onNodeDragStart={() => setIsDragging(true)}
          onNodeDragStop={() => setIsDragging(false)}
          onNodeMouseLeave={handleNodeLeave}
          defaultEdgeOptions={{
            type: "smoothstep",
            style: { stroke: "rgba(255,255,255,0.35)", strokeWidth: 1.6 },
          }}
          className="h-full w-full"
          fitView
        >
          <Background gap={20} size={1} color="rgba(255,255,255,0.08)" />
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
        {panelNodeId &&
          flowInstance &&
          (() => {
            const selectedNode = nodes.find((node) => node.id === panelNodeId);
            if (!selectedNode) {
              return null;
            }
            const position =
              selectedNode.positionAbsolute ?? selectedNode.position;
            const screenX = position.x * viewport.zoom + viewport.x;
            const screenY = position.y * viewport.zoom + viewport.y;
            const nodeElement = document.querySelector(
              `[data-id="${selectedNode.id}"]`,
            ) as HTMLElement | null;
            const nodeRect = nodeElement?.getBoundingClientRect();
            const nodeWidth = nodeRect?.width;
            const panelTop =
              screenY + (nodeRect?.height ?? 0) + 10 * viewport.zoom;
            return (
              <div
                className={`pointer-events-auto absolute z-10 text-white transition-all duration-300 ${
                  panelVisible
                    ? "translate-y-0 opacity-100"
                    : "-translate-y-2 opacity-0"
                }`}
                style={{
                  left: nodeRect?.left ?? screenX,
                  top: panelTop,
                  width: nodeWidth,
                }}
              >
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-2 py-1.5 shadow-lg shadow-black/30">
                  <Input
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Ask a research question..."
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleAsk();
                      }
                    }}
                    disabled={busy}
                    className="h-8 border-transparent bg-transparent text-xs text-white placeholder:text-white/40 focus-visible:ring-0"
                  />
                  <Button
                    size="sm"
                    className="h-8 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 px-4 text-xs font-semibold text-slate-900 shadow-lg shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-xl"
                    onClick={handleAsk}
                    disabled={busy || !prompt.trim()}
                  >
                    {busy ? "..." : "Send"}
                  </Button>
                </div>
              </div>
            );
          })()}
        {!selectedId && (
          <div className="pointer-events-none absolute right-6 top-6 rounded-full border border-white/10 bg-slate-900/80 px-4 py-2 text-xs uppercase tracking-[0.2em] text-white/60">
            Click a node to ask
          </div>
        )}
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
  );
}
