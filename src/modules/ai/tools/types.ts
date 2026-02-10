import type { LanguageModel, UIMessage, UITools } from "ai";
import type {
  DeepResearchPersistenceAdapter,
  LineSelection,
} from "../../../shared/deepresearch";

export interface DeertubeMessageMetadata {
  status?: "pending" | "complete" | "failed";
  error?: string;
}

interface SubagentStreamPayload {
  toolCallId: string;
  toolName?: string;
  messages: SubagentUIMessage[];
}

export interface DeepSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  excerpts?: string[];
  referenceIds?: number[];
  viewpoint?: string;
  error?: string;
}

export interface DeepSearchReference {
  refId: number;
  uri: string;
  pageId: string;
  url: string;
  title?: string;
  viewpoint: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface DeepSearchStreamPayload {
  toolCallId: string;
  toolName?: string;
  query?: string;
  projectId?: string;
  searchId?: string;
  status?: "running" | "complete" | "failed";
  sources?: DeepSearchSource[];
  references?: DeepSearchReference[];
  prompt?: string;
  conclusion?: string;
  error?: string;
  complete?: boolean;
}

export interface SubagentUIDataParts {
  "subagent-stream": SubagentStreamPayload;
}

export interface DeepSearchUIDataParts {
  "deepsearch-stream": DeepSearchStreamPayload;
  "deepsearch-done": DeepSearchStreamPayload;
}

export type DeertubeUIDataTypes = Record<string, unknown> &
  SubagentUIDataParts &
  DeepSearchUIDataParts;

export type SubagentUIMessage = UIMessage<
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  UITools
>;

export interface ToolConfig {
  model?: LanguageModel;
  searchModel?: LanguageModel;
  extractModel?: LanguageModel;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
}

export interface SearchResult {
  url: string;
  title?: string;
  viewpoint: string;
  content?: string;
  pageId?: string;
  lineCount?: number;
  selections: LineSelection[];
  broken?: boolean;
  inrelavate?: boolean;
  error?: string;
}

export interface ExtractedEvidence {
  selections: LineSelection[];
  contentsBySelection: Map<string, string>;
}
