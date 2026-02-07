import {
  InferUITools,
  Output,
  UIMessage,
  UIMessageStreamWriter,
  generateText,
  readUIMessageStream,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../../types/json";
import { isJsonObject } from "../../types/json";
import {
  buildDeepResearchRefUri,
  type DeepResearchPersistenceAdapter,
  type DeepResearchReferenceRecord,
  type LineRange,
  type LineSelection,
} from "../../shared/deepresearch";

export interface DeertubeMessageMetadata {
  status?: "pending" | "complete" | "failed";
  error?: string;
}

export type DeertubeUITools = InferUITools<ReturnType<typeof createTools>>;

export type DeertubeUIMessage = UIMessage<
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  DeertubeUITools
>;

interface SubagentStreamPayload {
  toolCallId: string;
  toolName?: string;
  messages: DeertubeUIMessage[];
}

export interface DeepSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  excerpts?: string[];
  referenceIds?: number[];
  error?: string;
}

export interface DeepSearchReference {
  refId: number;
  uri: string;
  pageId: string;
  url: string;
  title?: string;
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

interface ToolConfig {
  model?: LanguageModel;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
}

const noStepLimit = () => false;

const TavilyOptionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z
    .string()
    .optional()
    .describe("Optional text field from Tavily; non-string values are ignored."),
);

const TavilyOptionalNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" || value === null ? value : undefined),
  z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional nullable text from Tavily; null is preserved, non-string values are ignored.",
    ),
);

const TavilySearchResultSchema = z.object({
  title: TavilyOptionalStringSchema.describe(
    "Result title as returned by Tavily.",
  ),
  url: TavilyOptionalStringSchema.describe(
    "Canonical result URL for retrieval and extraction.",
  ),
  content: TavilyOptionalStringSchema.describe(
    "Short content preview returned by Tavily.",
  ),
  raw_content: TavilyOptionalNullableStringSchema.describe(
    "Optional full raw content from Tavily; can be null or absent.",
  ),
  snippet: TavilyOptionalStringSchema.describe(
    "Alternative snippet field from Tavily.",
  ),
  description: TavilyOptionalStringSchema.describe(
    "Alternative summary/description for the result.",
  ),
}).describe("Single Tavily search result item.");

type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

const TavilyResponseSchema = z.object({
  results: z
    .array(TavilySearchResultSchema)
    .optional()
    .describe("List of Tavily search results when the API call succeeds."),
}).describe("Tavily search response payload.");

const LineRangeSchema = z.object({
  start: z
    .number()
    .int()
    .positive()
    .describe("Inclusive 1-based start line number."),
  end: z.number().int().positive().describe("Inclusive 1-based end line number."),
}).describe("Inclusive line range over line-numbered markdown.");

const LineSelectionSchema = LineRangeSchema.extend({
  text: z
    .string()
    .min(1)
    .describe("Raw markdown text cut from the corresponding line range."),
}).describe("Extracted segment that includes line range and raw text.");

const ExtractSubagentFinalSchema = z.object({
  broken: z
    .boolean()
    .default(false)
    .describe("Whether markdown is unavailable/corrupted/blocked for this page."),
  inrelavate: z
    .boolean()
    .default(false)
    .describe("Whether the page is unrelated to the query."),
  ranges: z
    .array(LineRangeSchema)
    .default([])
    .describe("Relevant inclusive line ranges."),
  error: z
    .string()
    .optional()
    .describe("Optional extraction error reason for this page."),
}).describe("Final structured output of extract subagent.");

const SearchSubagentFinalItemSchema = z.object({
  url: z
    .string()
    .optional()
    .describe("Source URL when available. Can be omitted for global errors."),
  ranges: z
    .array(LineRangeSchema)
    .default([])
    .describe("Relevant inclusive line ranges for this URL."),
  broken: z
    .boolean()
    .optional()
    .describe("Whether this URL is blocked/unavailable/corrupted."),
  inrelavate: z
    .boolean()
    .optional()
    .describe("Whether this URL is unrelated to the query."),
  error: z
    .string()
    .optional()
    .describe("Optional per-URL error reason."),
}).describe("Single final output item of search subagent.");

const SearchSubagentFinalSchema = z.object({
  results: z
    .array(SearchSubagentFinalItemSchema)
    .default([])
    .describe("Per-URL structured search-subagent results."),
  errors: z
    .array(z.string().describe("Global error message for failed search/extract attempts."))
    .default([])
    .describe("Global subagent errors not tied to a specific URL."),
}).describe("Final structured output of search subagent.");

const SEARCH_SUBAGENT_SYSTEM = [
  "You are the DeepResearch subagent. Your task is to collect structured evidence through web search and page extraction.",
  "Available tools:",
  "- search: Use Tavily to find candidate pages.",
  "- extract: Extract query-relevant passages from a specific URL.",
  "Source quality policy:",
  "- Prefer high-credibility sources: established media with strong editorial standards and low misinformation history, official institutions, peer-reviewed journals, top conferences, and expert domain publications.",
  "- Avoid low-credibility or rumor-heavy sources unless they are necessary for contrast and clearly labeled.",
  "Search strategy:",
  "- For each task, search in both the original user-question language and English.",
  "- Do not let off-topic result trends redirect your judgment. If results drift from the intended topic, reformulate and continue searching.",
  "- If one search is insufficient, iterate with alternative keywords, synonyms, and related concepts.",
  "- If no reasonable results are found, proactively try multiple new keyword combinations before concluding failure.",
  "Workflow:",
  "1) Call search to gather candidates (<=6 per query, multiple query rounds allowed).",
  "2) Select relevant high-quality URLs and call extract(url, query) for each.",
  "3) Extraction is mandatory. Do not stop after search-only results.",
  "4) In final JSON, use `ranges` as the evidence field for each URL.",
  "5) Every returned range must come from the corresponding extract result for the same URL.",
  "6) If a URL is unrelated, mark `inrelavate=true` and return `ranges=[]` for that URL.",
  "7) If all attempted search calls fail, or all attempted extract calls fail, return those failure reasons in final JSON.",
  "8) Fatal tool failure rule: if every search call fails (e.g. Tavily errors) or every extract call fails (e.g. Jina errors), include clear reasons in `errors` so the outer agent can surface the failure to the user.",
  "9) Return a JSON object only: { results: [{ url?: string, ranges: [{ start, end }], broken?: boolean, inrelavate?: boolean, error?: string }], errors?: string[] }.",
  "Output rule: return JSON only, with no extra prose.",
].join("\n");

const EXTRACT_SUBAGENT_SYSTEM = [
  "You are the Extract subagent.",
  "Input: query + line-numbered markdown.",
  "Goal: select the most relevant line ranges for the query.",
  "Output JSON: { broken: boolean, inrelavate: boolean, ranges: [{ start, end }] }.",
  "Rules:",
  "- Line numbers start from 1. start/end are inclusive.",
  "- Keep ranges coherent and avoid oversized spans.",
  "- If content is unavailable or clearly corrupted, return broken=true and ranges=[].",
  "- If the page is unrelated to query, return inrelavate=true and ranges=[].",
  "- For large markdown, prioritize the grep/readLines tools to explore before deciding ranges.",
  "Return JSON only.",
].join("\n");

const DEEPSEARCH_SYSTEM = [
  "You are a deep-research assistant.",
  "You are given numbered references.",
  "Answer in the same language as the user's question.",
  "Write a concise answer and cite evidence inline using bracket indices like [1] and [2].",
  "If there are zero references, do not output citation markers like [1] or [2], and do not output a `References` section.",
  "Only cite provided indices, do not invent new indices, and do not output footnotes.",
  "Do not group citations as [1,2] or [1-2]. Write separate markers like [1], [2].",
].join("\n");

const parseJson = (raw: string): JsonValue => JSON.parse(raw) as JsonValue;

const isRecord = (value: unknown): value is JsonObject => isJsonObject(value);

const writeSubagentStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  messages: DeertubeUIMessage[],
) => {
  if (!writer || !toolCallId) return;
  writer.write({
    type: "data-subagent-stream",
    id: toolCallId,
    data: { toolCallId, toolName, messages },
  });
};

const writeDeepSearchStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  payload: Omit<DeepSearchStreamPayload, "toolCallId" | "toolName">,
  done = false,
) => {
  if (!writer || !toolCallId) return;
  writer.write({
    type: done ? "data-deepsearch-done" : "data-deepsearch-stream",
    id: toolCallId,
    data: {
      toolCallId,
      toolName,
      ...payload,
      complete: done || payload.complete,
    },
  });
};

type AnyUIMessagePart = NonNullable<DeertubeUIMessage["parts"]>[number];

const isTextPart = (
  part: AnyUIMessagePart,
): part is AnyUIMessagePart & { text: string } =>
  part.type === "text" && "text" in part;

const isToolPart = (part: AnyUIMessagePart): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

const getToolName = (part: AnyUIMessagePart): string | undefined => {
  if (part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }
  if (
    part.type === "dynamic-tool" &&
    "toolName" in part &&
    typeof part.toolName === "string"
  ) {
    return part.toolName;
  }
  return undefined;
};

const extractText = (message: DeertubeUIMessage): string => {
  if (!message.parts) return "";
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
};

const collectToolOutputs = (
  message: DeertubeUIMessage,
): { name?: string; output: unknown }[] => {
  if (!message.parts) return [];
  return message.parts.filter(isToolPart).flatMap((part) => {
    if (!("output" in part) || part.output === undefined) {
      return [];
    }
    return [
      {
        name: getToolName(part),
        output: part.output,
      },
    ];
  });
};

const normalizeRanges = (
  ranges: JsonValue | null,
  maxLine: number,
): { start: number; end: number }[] => {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .map((item) => {
      if (!isRecord(item)) return null;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const clampedStart = Math.max(1, Math.min(maxLine, Math.floor(start)));
      const clampedEnd = Math.max(1, Math.min(maxLine, Math.floor(end)));
      if (clampedEnd < clampedStart) return null;
      return { start: clampedStart, end: clampedEnd };
    })
    .filter((item): item is { start: number; end: number } => item !== null);
};

const splitLines = (markdown: string): string[] => markdown.split(/\r?\n/);

const formatLineNumbered = (
  lines: string[],
  offset = 0,
  totalLines?: number,
): string => {
  const width = String(totalLines ?? lines.length + offset).length;
  return lines
    .map((line, index) => {
      const lineNumber = String(index + 1 + offset).padStart(width, "0");
      return `${lineNumber} | ${line}`;
    })
    .join("\n");
};

const buildSelectionsFromRanges = (
  lines: string[],
  ranges: LineRange[],
): LineSelection[] => {
  const unique = new Map<string, LineSelection>();
  ranges.forEach((range) => {
    const text = lines
      .slice(range.start - 1, range.end)
      .join("\n")
      .trim();
    if (!text) {
      return;
    }
    const key = `${range.start}:${range.end}:${text}`;
    unique.set(key, {
      start: range.start,
      end: range.end,
      text,
    });
  });
  return Array.from(unique.values());
};

const buildLineNumberedContentsFromRanges = (
  lines: string[],
  ranges: LineRange[],
): string[] => {
  const unique = new Map<string, string>();
  ranges.forEach((range) => {
    const slice = lines.slice(range.start - 1, range.end);
    const text = formatLineNumbered(slice, range.start - 1, lines.length).trim();
    if (!text) {
      return;
    }
    unique.set(`${range.start}:${range.end}`, text);
  });
  return Array.from(unique.values());
};

const parseLineSelections = (value: unknown): LineSelection[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const start = Number(entry.start);
      const end = Number(entry.end);
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
        return null;
      }
      return {
        start: Math.max(1, Math.floor(start)),
        end: Math.max(1, Math.floor(end)),
        text,
      } satisfies LineSelection;
    })
    .filter((entry): entry is LineSelection => entry !== null);
};

const parseLineRanges = (value: unknown): LineRange[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const dedupe = new Map<string, LineRange>();
  value.forEach((entry) => {
    if (!isRecord(entry)) {
      return;
    }
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    const normalizedStart = Math.max(1, Math.floor(start));
    const normalizedEnd = Math.max(1, Math.floor(end));
    if (normalizedEnd < normalizedStart) {
      return;
    }
    const range: LineRange = {
      start: normalizedStart,
      end: normalizedEnd,
    };
    dedupe.set(`${range.start}:${range.end}`, range);
  });
  return Array.from(dedupe.values());
};

const isRangeContainedBy = (candidate: LineRange, container: LineRange): boolean =>
  candidate.start >= container.start && candidate.end <= container.end;

const intersectRanges = (
  left: LineRange,
  right: LineRange,
): LineRange | null => {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  if (end < start) {
    return null;
  }
  return { start, end };
};

const deriveNumberedContentForRange = (
  target: LineRange,
  contentsByRange: Map<string, string>,
): string | undefined => {
  const exact = contentsByRange.get(`${target.start}:${target.end}`);
  if (exact && exact.trim().length > 0) {
    return exact.trim();
  }
  for (const [key, content] of contentsByRange.entries()) {
    const [startRaw, endRaw] = key.split(":");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    if (!isRangeContainedBy(target, { start, end })) {
      continue;
    }
    const selectedLines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => {
        const match = line.match(/^(\d+)\s+\|/);
        if (!match) {
          return false;
        }
        const lineNo = Number(match[1]);
        return Number.isFinite(lineNo) && lineNo >= target.start && lineNo <= target.end;
      });
    if (selectedLines.length > 0) {
      return selectedLines.join("\n");
    }
  }
  return undefined;
};

const stripLineNumbers = (numbered: string): string =>
  numbered
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

const summarizeRanges = (ranges: LineRange[], limit = 6): string[] =>
  ranges.slice(0, limit).map((range) => `${range.start}-${range.end}`);

const summarizeContentsPreview = (contents: string[], limit = 2): string[] =>
  contents.slice(0, limit).map((content) => clampText(content, 180));

async function fetchTavilySearch(
  query: string,
  maxResults: number,
  apiKey?: string,
): Promise<TavilySearchResult[]> {
  const resolvedKey = apiKey ?? process.env.TAVILY_API_KEY;
  if (!resolvedKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolvedKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: false,
      search_depth: "advanced",
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.warn("[tavily.search.error]", {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error(`Tavily search failed: ${response.status}`);
  }
  let parsedJson: JsonValue;
  try {
    parsedJson = JSON.parse(raw) as JsonValue;
  } catch (error) {
    console.warn("[tavily.search.parse]", {
      query,
      status: response.status,
      error: error instanceof Error ? error.message : "unknown",
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error("Tavily search response parse failed.");
  }
  const parsed = TavilyResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    console.warn("[tavily.search.schema]", {
      query,
      status: response.status,
      issue: firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "invalid",
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error("Tavily search response schema invalid.");
  }
  const results = parsed.data.results ?? [];
  if (results.length === 0) {
    console.warn("[tavily.search.empty]", {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    });
  }
  return results;
}

async function fetchJinaReaderMarkdown(
  url: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<string> {
  const normalizedBase =
    baseUrl && baseUrl.trim().length > 0
      ? baseUrl.trim()
      : "https://r.jina.ai/";
  const readerUrl = `${normalizedBase}${url}`;
  const response = await fetch(readerUrl, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Jina reader failed: ${response.status}`);
  }
  const raw = await response.text();
  const compact = raw.trim();
  if (!compact.startsWith("{")) {
    return raw;
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new Error(
      `Jina response JSON parse failed for ${url}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
  if (typeof parsed === "string") {
    return parsed;
  }
  if (typeof parsed === "object") {
    const obj = parsed as JsonObject;
    if (typeof obj.content === "string") {
      return obj.content;
    }
    const nested = obj.data;
    if (nested && typeof nested === "object") {
      const nestedContent = (nested as JsonObject).content;
      if (typeof nestedContent === "string") {
        return nestedContent;
      }
    }
    return JSON.stringify(obj, null, 2);
  }
  return raw;
}

interface SearchResult {
  url: string;
  title?: string;
  pageId?: string;
  lineCount?: number;
  ranges: LineRange[];
  selections: LineSelection[];
  contents: string[];
  broken?: boolean;
  inrelavate?: boolean;
  error?: string;
}

const normalizeSearchResults = (raw: JsonValue): SearchResult[] => {
  if (!Array.isArray(raw)) {
    throw new Error("Search subagent output must be a JSON array.");
  }
  const normalized: SearchResult[] = [];
  raw.forEach((item) => {
    if (!isRecord(item)) {
      return;
    }
    const url = typeof item.url === "string" ? item.url : "";
    const title = typeof item.title === "string" ? item.title : undefined;
    const ranges = parseLineRanges(item.ranges);
    const broken = typeof item.broken === "boolean" ? item.broken : undefined;
    const inrelavate =
      typeof item.inrelavate === "boolean" ? item.inrelavate : undefined;
    const error = typeof item.error === "string" ? item.error : undefined;
    if (
      !url ||
      (ranges.length === 0 &&
        broken !== true &&
        inrelavate !== true &&
        !error)
    ) {
      return;
    }
    normalized.push({
      url,
      title,
      ranges,
      selections: [],
      contents: [],
      broken,
      inrelavate,
      error,
    });
  });
  return normalized;
};

const dedupeSearchResults = (results: SearchResult[]): SearchResult[] => {
  const map = new Map<string, SearchResult>();
  const rangeKey = (range: LineRange): string => `${range.start}:${range.end}`;
  const selectionKey = (selection: LineSelection): string =>
    `${selection.start}:${selection.end}:${selection.text}`;
  for (const item of results) {
    const existing = map.get(item.url);
    if (!existing) {
      map.set(item.url, {
        ...item,
        ranges: [...item.ranges],
        selections: [...item.selections],
        contents: [...item.contents],
      });
    } else {
      const mergedContents = Array.from(
        new Set([...existing.contents, ...item.contents]),
      );
      const rangeMap = new Map<string, LineRange>();
      [...existing.ranges, ...item.ranges].forEach((range) => {
        rangeMap.set(rangeKey(range), range);
      });
      const mergedRanges = Array.from(rangeMap.values());
      const selectionMap = new Map<string, LineSelection>();
      [...existing.selections, ...item.selections].forEach((selection) => {
        selectionMap.set(selectionKey(selection), selection);
      });
      const mergedSelections = Array.from(selectionMap.values());
      const hasResolvedContent =
        mergedContents.length > 0 ||
        mergedSelections.length > 0 ||
        mergedRanges.length > 0;
      map.set(item.url, {
        url: item.url,
        title: existing.title ?? item.title,
        pageId: existing.pageId ?? item.pageId,
        lineCount: existing.lineCount ?? item.lineCount,
        ranges: mergedRanges,
        selections: mergedSelections,
        contents: mergedContents,
        broken: hasResolvedContent
          ? undefined
          : (existing.broken ?? item.broken),
        inrelavate: hasResolvedContent
          ? undefined
          : (existing.inrelavate ?? item.inrelavate),
        error: hasResolvedContent ? undefined : (existing.error ?? item.error),
      });
    }
  }
  return Array.from(map.values());
};

const validateNormalizedSearchResultsAgainstExtractedContents = (
  query: string,
  normalized: SearchResult[],
  extractedEvidenceByUrl: Map<
    string,
    {
      ranges: LineRange[];
      selections: LineSelection[];
      contents: Set<string>;
      contentsByRange: Map<string, string>;
    }
  >,
): SearchResult[] =>
  normalized.flatMap((item) => {
    if (item.broken ?? false) {
      return [{
        ...item,
        ranges: [],
        selections: [],
        contents: [],
      }];
    }
    if (item.inrelavate ?? false) {
      return [{
        ...item,
        ranges: [],
        selections: [],
        contents: [],
      }];
    }
    const evidence = extractedEvidenceByUrl.get(item.url);
    if (!evidence || evidence.ranges.length === 0) {
      if (item.ranges.length === 0) {
        return [{
          ...item,
          selections: [],
          contents: [],
        }];
      }
      console.warn("[subagent.search.validate.drop.noEvidence]", {
        query,
        url: item.url,
        ranges: item.ranges.length,
      });
      return [];
    }
    if (item.ranges.length === 0) {
      return [{
        ...item,
        selections: [],
        contents: [],
      }];
    }
    const rangeKey = (range: LineRange): string => `${range.start}:${range.end}`;
    const convergedRangeMap = new Map<string, LineRange>();
    item.ranges.forEach((range) => {
      evidence.ranges.forEach((evidenceRange) => {
        const overlap = intersectRanges(range, evidenceRange);
        if (!overlap) {
          return;
        }
        convergedRangeMap.set(rangeKey(overlap), overlap);
      });
    });
    const convergedRanges = Array.from(convergedRangeMap.values()).sort((a, b) =>
      a.start === b.start ? a.end - b.end : a.start - b.start,
    );
    if (convergedRanges.length === 0) {
      console.warn("[subagent.search.validate.drop.noOverlap]", {
        query,
        url: item.url,
        requestedRanges: item.ranges,
        evidenceRanges: evidence.ranges,
      });
      return [];
    }
    const selectionByRange = new Map<string, LineSelection>();
    evidence.selections.forEach((selection) => {
      selectionByRange.set(rangeKey(selection), selection);
    });
    const resolvedSelectionsMap = new Map<string, LineSelection>();
    const resolvedContents: string[] = [];
    const resolvedRangesMap = new Map<string, LineRange>();
    convergedRanges.forEach((range) => {
      const key = rangeKey(range);
      const selection = selectionByRange.get(key);
      const numberedContent = deriveNumberedContentForRange(
        range,
        evidence.contentsByRange,
      );
      if (!selection) {
        if (numberedContent) {
          resolvedRangesMap.set(key, range);
          resolvedContents.push(numberedContent);
          const text = stripLineNumbers(numberedContent);
          if (text.length > 0) {
            resolvedSelectionsMap.set(
              `${range.start}:${range.end}:${text}`,
              {
                start: range.start,
                end: range.end,
                text,
              },
            );
          }
        }
        return;
      }
      resolvedSelectionsMap.set(
        `${selection.start}:${selection.end}:${selection.text}`,
        selection,
      );
      const preferredContent = numberedContent ?? selection.text;
      resolvedRangesMap.set(key, range);
      resolvedContents.push(preferredContent);
    });
    const resolvedRanges = Array.from(resolvedRangesMap.values()).sort((a, b) =>
      a.start === b.start ? a.end - b.end : a.start - b.start,
    );
    const resolvedSelections = Array.from(resolvedSelectionsMap.values());
    const contents = resolvedContents.filter((content) => content.length > 0);
    if (resolvedRanges.length === 0 || contents.length === 0) {
      console.warn("[subagent.search.validate.drop.noResolvedContent]", {
        query,
        url: item.url,
        convergedRanges,
      });
      return [];
    }
    return [{
      ...item,
      ranges: resolvedRanges,
      selections: resolvedSelections,
      contents,
    }];
  });

const clampText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;

const normalizeContents = (contents: string[]): string[] => {
  const cleaned = contents
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const limited: string[] = [];
  let total = 0;
  for (const entry of cleaned) {
    const slice = clampText(entry, 900);
    if (total + slice.length > 3200) break;
    limited.push(slice);
    total += slice.length;
    if (limited.length >= 6) break;
  }
  return limited;
};

const deriveSourceTitle = (url: string, fallback?: string): string => {
  if (!URL.canParse(url)) {
    return fallback ?? url;
  }
  const parsed = new URL(url);
  return parsed.hostname || (fallback ?? url);
};

const buildSnippet = (contents: string[]): string => {
  if (contents.length === 0) return "";
  return clampText(contents.join("\n"), 400);
};

const buildDeepSearchSources = (
  results: SearchResult[],
  references: DeepSearchReference[],
): DeepSearchSource[] => {
  const referenceIdsByUrl = new Map<string, number[]>();
  references.forEach((reference) => {
    const current = referenceIdsByUrl.get(reference.url) ?? [];
    current.push(reference.refId);
    referenceIdsByUrl.set(reference.url, current);
  });
  return results
    .filter((item) => {
      const referenceIds = referenceIdsByUrl.get(item.url) ?? [];
      return referenceIds.length > 0;
    })
    .map((item) => {
      const referenceIds = referenceIdsByUrl.get(item.url) ?? [];
      if (item.error) {
        const title = item.title ?? deriveSourceTitle(item.url, item.url);
        return {
          url: item.url,
          title,
          snippet: `Extraction error: ${clampText(item.error, 260)}`,
          error: item.error,
          excerpts: [],
          referenceIds,
        };
      }
      const contents = normalizeContents(item.contents);
      const snippet = buildSnippet(contents);
      const title =
        item.title ?? deriveSourceTitle(item.url, snippet.split("\n")[0]);
      return {
        url: item.url,
        title,
        snippet,
        excerpts: contents,
        referenceIds,
        error: item.error,
      };
    });
};

async function runExtractSubagent({
  query,
  lines,
  model,
  abortSignal,
}: {
  query: string;
  lines: string[];
  model: LanguageModel;
  abortSignal?: AbortSignal;
}): Promise<{
  ranges: LineRange[];
  broken: boolean;
  inrelavate: boolean;
  contents: string[];
  error?: string;
  rawModelOutput: string;
}> {
  const lineCount = lines.length;
  const markdownCharCount = lines.reduce(
    (total, line) => total + line.length + 1,
    0,
  );
  console.log("[subagent.extract.agent.start]", {
    query: clampText(query, 160),
    lineCount,
    markdownCharCount,
  });
  if (lineCount === 0) {
    console.log("[subagent.extract.agent.empty]", {
      query,
      lineCount,
    });
    return {
      ranges: [],
      broken: true,
      inrelavate: false,
      contents: [],
      rawModelOutput: "Empty markdown input.",
    };
  }
  const tooLarge = lineCount > 2200 || markdownCharCount > 180000;
  const previewLines = tooLarge ? lines.slice(0, 200) : lines;
  const preview = formatLineNumbered(previewLines, 0, lineCount);
  const sizeNote = tooLarge
    ? `Markdown is large (${lineCount} lines). Only the first 200 lines are shown. Use grep/readLines to inspect more.`
    : `Total markdown lines: ${lineCount}.`;
  let grepCallCount = 0;
  let readLinesCallCount = 0;

  const grepTool = tool({
    description:
      "Search all lines with a regex and return matching line numbers with surrounding context.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe("JavaScript regular-expression pattern used to search lines."),
      flags: z
        .string()
        .optional()
        .describe("Optional regex flags such as i, m, or g."),
      before: z
        .number()
        .min(0)
        .max(8)
        .optional()
        .describe("Number of context lines to include before each match."),
      after: z
        .number()
        .min(0)
        .max(8)
        .optional()
        .describe("Number of context lines to include after each match."),
      maxMatches: z
        .number()
        .min(1)
        .max(40)
        .optional()
        .describe("Maximum number of matches returned in one tool call."),
    }).describe("Input arguments for line-level regex grep."),
    outputSchema: z.object({
      matches: z.array(
        z.object({
          line: z.number().int().positive().describe("1-based line number of match."),
          text: z.string().describe("Exact line text that matched the pattern."),
          before: z
            .array(z.string().describe("Context line prefixed with its line number."))
            .describe("Context lines before the matched line."),
          after: z
            .array(z.string().describe("Context line prefixed with its line number."))
            .describe("Context lines after the matched line."),
        }),
      ).describe("Matched lines with local context."),
      total: z
        .number()
        .int()
        .nonnegative()
        .describe("Total number of matches returned."),
    }).describe("Grep output payload for extract subagent exploration."),
    execute: ({ pattern, flags, before = 2, after = 2, maxMatches = 20 }) => {
      grepCallCount += 1;
      const shouldLogGrepDetail =
        grepCallCount <= 5 || grepCallCount % 10 === 0;
      if (shouldLogGrepDetail) {
        console.log("[subagent.extract.agent.grep]", {
          call: grepCallCount,
          pattern: clampText(pattern, 120),
          flags: flags ?? "i",
          before,
          after,
          maxMatches,
        });
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags ?? "i");
      } catch (error) {
        throw new Error(
          `Invalid regex pattern for grep tool: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
      const matches: {
        line: number;
        text: string;
        before: string[];
        after: string[];
      }[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (!regex.test(lines[index])) continue;
        const start = Math.max(0, index - before);
        const end = Math.min(lines.length, index + after + 1);
        matches.push({
          line: index + 1,
          text: lines[index],
          before: lines.slice(start, index).map((line, offset) => {
            const lineNumber = start + offset + 1;
            return `${lineNumber} | ${line}`;
          }),
          after: lines.slice(index + 1, end).map((line, offset) => {
            const lineNumber = index + 2 + offset;
            return `${lineNumber} | ${line}`;
          }),
        });
        if (matches.length >= maxMatches) break;
      }
      if (shouldLogGrepDetail) {
        console.log("[subagent.extract.agent.grep.done]", {
          call: grepCallCount,
          pattern: clampText(pattern, 120),
          matches: matches.length,
          sample: matches.slice(0, 2).map((match) => ({
            line: match.line,
            text: clampText(match.text, 120),
          })),
        });
      } else if (grepCallCount === 6) {
        console.log("[subagent.extract.agent.grep.sampled]", {
          message: "Further grep logs are sampled (every 10th call).",
        });
      }
      return { matches, total: matches.length };
    },
  });

  const readLinesTool = tool({
    description: "Read content by a specified inclusive line range.",
    inputSchema: z.object({
      start: z
        .number()
        .min(1)
        .describe("Requested inclusive 1-based start line."),
      end: z.number().min(1).describe("Requested inclusive 1-based end line."),
    }).describe("Input arguments for reading a block of line-numbered markdown."),
    outputSchema: z.object({
      start: z
        .number()
        .int()
        .positive()
        .describe("Effective clamped inclusive 1-based start line."),
      end: z
        .number()
        .int()
        .positive()
        .describe("Effective clamped inclusive 1-based end line."),
      lines: z
        .string()
        .describe("Line-numbered markdown slice covering start..end."),
    }).describe("Read-lines output with normalized bounds and text."),
    execute: ({ start, end }) => {
      readLinesCallCount += 1;
      const shouldLogReadLinesDetail =
        readLinesCallCount <= 5 || readLinesCallCount % 10 === 0;
      const safeStart = Math.max(1, Math.min(lineCount, Math.floor(start)));
      const safeEnd = Math.max(safeStart, Math.min(lineCount, Math.floor(end)));
      const slice = lines.slice(safeStart - 1, safeEnd);
      if (shouldLogReadLinesDetail) {
        console.log("[subagent.extract.agent.readLines]", {
          call: readLinesCallCount,
          requestedStart: start,
          requestedEnd: end,
          start: safeStart,
          end: safeEnd,
          lineCount: slice.length,
          preview: summarizeContentsPreview(
            [formatLineNumbered(slice, safeStart - 1, lineCount)],
            1,
          ),
        });
      } else if (readLinesCallCount === 6) {
        console.log("[subagent.extract.agent.readLines.sampled]", {
          message: "Further readLines logs are sampled (every 10th call).",
        });
      }
      return {
        start: safeStart,
        end: safeEnd,
        lines: formatLineNumbered(slice, safeStart - 1, lineCount),
      };
    },
  });

  console.log("[subagent.extract.agent.model]", {
    query,
    lineCount,
    tooLarge,
    previewLines: previewLines.length,
  });
  const result = await generateText({
    model,
    system: EXTRACT_SUBAGENT_SYSTEM,
    prompt: `Query: ${query}\n${sizeNote}\n\nLine-numbered markdown:\n${preview}`,
    tools: {
      grep: grepTool,
      readLines: readLinesTool,
    },
    toolChoice: "auto",
    stopWhen: noStepLimit,
    abortSignal,
  });
  console.log("[subagent.extract.agent.raw]", {
    query: clampText(query, 160),
    rawLength: result.text.length,
    rawPreview: clampText(result.text, 240),
  });

  const structured = await generateText({
    model,
    output: Output.object({
      schema: ExtractSubagentFinalSchema,
      name: "extract_subagent_result",
      description:
        "Final structured extract result with flags, ranges, and optional error.",
    }),
    system:
      "Convert the raw extract-subagent output into valid JSON that strictly matches the schema.",
    prompt: [
      `Query: ${query}`,
      `Line count: ${lineCount}`,
      "Raw extract-subagent output:",
      result.text,
    ].join("\n\n"),
    abortSignal,
  });
  const parsed = structured.output;
  const broken = parsed.broken;
  const inrelavate = parsed.inrelavate;
  const parsedRanges = normalizeRanges(parsed.ranges as unknown as JsonValue, lineCount);
  const errorMessage =
    typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : undefined;
  const ranges = inrelavate ? [] : parsedRanges;
  const numberedContents = buildLineNumberedContentsFromRanges(lines, ranges);
  console.log("[subagent.extract.agent.parsed]", {
    query: clampText(query, 160),
    broken,
    inrelavate,
    error: errorMessage ? clampText(errorMessage, 240) : undefined,
    ranges: ranges.length,
    rangeSummary: summarizeRanges(ranges),
    contents: numberedContents.length,
    contentsPreview: summarizeContentsPreview(numberedContents),
    rawModelOutputPreview: clampText(result.text, 220),
  });
  return {
    ranges,
    broken,
    inrelavate,
    error: errorMessage,
    contents: numberedContents,
    rawModelOutput: result.text,
  };
}

async function runSearchSubagent({
  query,
  searchId,
  model,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
  deepResearchStore,
}: {
  query: string;
  searchId: string;
  model: LanguageModel;
  writer?: UIMessageStreamWriter;
  toolCallId?: string;
  toolName?: string;
  abortSignal?: AbortSignal;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
}): Promise<SearchResult[]> {
  console.log("[subagent.runSearch]", {
    query,
    toolCallId,
  });
  const accumulatedMessages: DeertubeUIMessage[] = [];
  let lastText = "";
  const extracted: SearchResult[] = [];
  const searchToolErrors: string[] = [];
  const extractToolErrors: string[] = [];
  let searchToolCallCount = 0;
  let searchToolErrorCount = 0;
  let extractToolCallCount = 0;
  let extractToolErrorCount = 0;
  const extractedEvidenceByUrl = new Map<
    string,
    {
      ranges: LineRange[];
      selections: LineSelection[];
      contents: Set<string>;
      contentsByRange: Map<string, string>;
    }
  >();
  const searchLookup = new Map<string, { title?: string; snippet?: string }>();

  const searchTool = tool({
    description:
      "Search the web via Tavily and return ranked candidate results.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural-language web search query."),
    }).describe("Input payload for Tavily web search."),
    outputSchema: z.object({
      results: z
        .array(TavilySearchResultSchema)
        .describe("Ranked Tavily search results."),
      error: z
        .string()
        .optional()
        .describe("Search error reason when this tool call fails."),
    }).describe("Tavily search tool output."),
    execute: async ({ query: inputQuery }) => {
      searchToolCallCount += 1;
      console.log("[subagent.search]", {
        query: inputQuery,
        maxResults: 20,
      });
      try {
        const results = await fetchTavilySearch(inputQuery, 20, tavilyApiKey);
        results.forEach((item) => {
          const url = item.url?.trim();
          if (!url) {
            return;
          }
          searchLookup.set(url, {
            title: item.title ?? item.description ?? undefined,
            snippet: item.content ?? item.snippet ?? undefined,
          });
        });
        console.log("[subagent.search.results]", {
          count: results.length,
          top: results
            .slice(0, 3)
            .map((item) => item.url ?? item.title ?? "unknown"),
        });
        return { results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        console.error("[subagent.search.error]", {
          query: inputQuery,
          error: clampText(message, 260),
        });
        return {
          results: [],
          error: message,
        };
      }
    },
  });

  const ExtractToolOutputSchema = z.object({
    url: z.string().min(1).describe("Source URL that was extracted."),
    title: z
      .string()
      .optional()
      .describe("Resolved page title when available."),
    pageId: z
      .string()
      .optional()
      .describe("Persisted page identifier in DeepResearch storage."),
    lineCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Total line count of fetched markdown."),
    broken: z
      .boolean()
      .describe("Whether page content is unavailable/corrupted/blocked."),
    inrelavate: z
      .boolean()
      .describe("Whether the page is judged unrelated to query."),
    ranges: z
      .array(LineRangeSchema)
      .describe("Relevant inclusive line ranges selected by extract subagent."),
    selections: z
      .array(LineSelectionSchema)
      .describe("Range selections with line metadata and raw text."),
    contents: z
      .array(
        z
          .string()
          .describe(
            "Line-numbered markdown segment for the selected range; each entry aligns with ranges[index].",
          ),
      )
      .describe("Line-numbered extracted content chunks used by search subagent."),
    error: z
      .string()
      .optional()
      .describe("Extraction error message when this URL cannot be extracted."),
    rawModelOutput: z
      .string()
      .describe("Raw text output returned by extract subagent model."),
  }).describe("Extraction result for one URL.");

  const extractTool = tool({
    description:
      "Fetch markdown from a URL and extract passages relevant to the query.",
    inputSchema: z.object({
      url: z.string().min(1).describe("Target page URL to fetch and extract from."),
      query: z
        .string()
        .min(1)
        .describe("User query used to locate relevant passages."),
    }).describe("Input payload for single-URL extraction."),
    outputSchema: ExtractToolOutputSchema,
    execute: async (
      { url, query: extractQuery },
      options,
    ): Promise<z.infer<typeof ExtractToolOutputSchema>> => {
      extractToolCallCount += 1;
      const extractStartedAt = Date.now();
      let stage = "init";
      const lookup = searchLookup.get(url);
      let pageId: string | undefined;
      let lineCount = 0;
      let rawModelOutput = "";
      console.log("[subagent.extract]", {
        url: clampText(url, 220),
        query: clampText(extractQuery, 160),
      });
      try {
        stage = "fetch-markdown";
        const markdownFetchStartedAt = Date.now();
        console.log("[subagent.extract.fetch.start]", {
          url: clampText(url, 220),
          query: clampText(extractQuery, 160),
        });
        const markdown = await fetchJinaReaderMarkdown(
          url,
          jinaReaderBaseUrl,
          jinaReaderApiKey,
        );
        console.log("[subagent.extract.fetch.done]", {
          url: clampText(url, 220),
          elapsedMs: Date.now() - markdownFetchStartedAt,
          markdownCharCount: markdown.length,
        });
        if (!markdown.trim()) {
          throw new Error("Jina content unavailable.");
        }
        const fetchedAt = new Date().toISOString();
        const lines = splitLines(markdown);
        lineCount = lines.length;
        console.log("[subagent.extract.markdown]", {
          url: clampText(url, 220),
          lineCount: lines.length,
          markdownCharCount: markdown.length,
          markdownPreview: clampText(markdown, 240),
        });
        if (deepResearchStore) {
          stage = "save-page";
          const persistedPage = await deepResearchStore.savePage({
            searchId,
            query: extractQuery,
            url,
            title: lookup?.title,
            markdown,
            fetchedAt,
          });
          pageId = persistedPage.pageId;
          lineCount = persistedPage.lineCount;
          console.log("[subagent.extract.pageSaved]", {
            url: clampText(url, 220),
            pageId,
            lineCount,
          });
        }

        stage = "extract-agent";
        const {
          ranges,
          broken: extractedBroken,
          inrelavate,
          error: extractedError,
          contents,
          rawModelOutput: extractRawModelOutput,
        } = await runExtractSubagent({
          query: extractQuery,
          lines,
          model,
          abortSignal: options.abortSignal,
        });
        rawModelOutput = extractRawModelOutput;
        const selections = buildSelectionsFromRanges(lines, ranges);
        if (deepResearchStore && pageId) {
          stage = "save-extraction";
          await deepResearchStore.saveExtraction({
            searchId,
            pageId,
            query: extractQuery,
            url,
            broken: extractedBroken,
            lineCount,
            ranges,
            selections,
            rawModelOutput,
            extractedAt: new Date().toISOString(),
          });
          console.log("[subagent.extract.extractionSaved]", {
            url: clampText(url, 220),
            pageId,
            ranges: ranges.length,
            selections: selections.length,
          });
        }
        console.log("[subagent.extract.done]", {
          url: clampText(url, 220),
          broken: extractedBroken,
          inrelavate,
          error: extractedError ? clampText(extractedError, 220) : undefined,
          ranges: ranges.length,
          rangeSummary: summarizeRanges(ranges),
          selections: selections.length,
          contents: contents.length,
          contentsPreview: summarizeContentsPreview(contents),
          elapsedMs: Date.now() - extractStartedAt,
        });
        const result = {
          url,
          title: lookup?.title,
          pageId,
          lineCount,
          broken: extractedBroken,
          inrelavate,
          ranges,
          selections,
          contents,
          error: extractedError,
          rawModelOutput,
        };
        console.log("[subagent.extract.result]", {
          url: clampText(url, 220),
          title: lookup?.title ? clampText(lookup.title, 140) : undefined,
          pageId,
          lineCount,
          broken: extractedBroken,
          inrelavate,
          ranges: ranges.length,
          selections: selections.length,
          contents: contents.length,
          error: extractedError ? clampText(extractedError, 220) : undefined,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorMessage = `${stage}: ${message}`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        console.error("[subagent.extract.error]", {
          url: clampText(url, 220),
          query: clampText(extractQuery, 160),
          stage,
          elapsedMs: Date.now() - extractStartedAt,
          error: clampText(errorMessage, 300),
        });
        return {
          url,
          title: lookup?.title,
          pageId,
          lineCount,
          broken: true,
          inrelavate: false,
          ranges: [],
          selections: [],
          contents: [],
          error: errorMessage,
          rawModelOutput,
        };
      }
    },
  });

  const result = streamText({
    model,
    system: SEARCH_SUBAGENT_SYSTEM,
    messages: [{ role: "user", content: query } satisfies ModelMessage],
    tools: {
      search: searchTool,
      extract: extractTool,
    },
    toolChoice: "auto",
    stopWhen: noStepLimit,
    abortSignal,
  });

  const stream = result.toUIMessageStream<DeertubeUIMessage>();
  const uiMessages = readUIMessageStream<DeertubeUIMessage>({ stream });

  for await (const uiMessage of uiMessages) {
    const existingIndex = accumulatedMessages.findIndex(
      (item) => item.id === uiMessage.id,
    );
    if (existingIndex >= 0) {
      accumulatedMessages[existingIndex] = uiMessage;
    } else {
      accumulatedMessages.push(uiMessage);
    }
    writeSubagentStream(writer, toolCallId, toolName, accumulatedMessages);
    if (uiMessage.role === "assistant") {
      lastText = extractText(uiMessage);
      const outputs = collectToolOutputs(uiMessage);
      outputs.forEach((output) => {
        if (output.name === "search") {
          if (isRecord(output.output)) {
            const errorMessage =
              typeof output.output.error === "string"
                ? output.output.error.trim()
                : "";
            if (errorMessage.length > 0) {
              searchToolErrors.push(errorMessage);
            }
          }
          return;
        }
        if (output.name !== "extract") return;
        if (!isRecord(output.output)) return;
        const url =
          typeof output.output.url === "string" ? output.output.url : "";
        const ranges = parseLineRanges(output.output.ranges);
        const contents = Array.isArray(output.output.contents)
          ? output.output.contents.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : [];
        const selections = parseLineSelections(output.output.selections);
        const title =
          typeof output.output.title === "string"
            ? output.output.title
            : undefined;
        const pageId =
          typeof output.output.pageId === "string"
            ? output.output.pageId
            : undefined;
        const lineCountRaw = Number(output.output.lineCount);
        const lineCount =
          Number.isFinite(lineCountRaw) && lineCountRaw > 0
            ? Math.floor(lineCountRaw)
            : undefined;
        const broken =
          typeof output.output.broken === "boolean"
            ? output.output.broken
            : undefined;
        const inrelavate =
          typeof output.output.inrelavate === "boolean"
            ? output.output.inrelavate
            : undefined;
        const errorMessage =
          typeof output.output.error === "string"
            ? output.output.error
            : undefined;
        const normalizedContents = contents;
        if (
          !url ||
          (ranges.length === 0 &&
            normalizedContents.length === 0 &&
            selections.length === 0 &&
            !broken &&
            !inrelavate &&
            !errorMessage)
        )
          return;
        const existingEvidence = extractedEvidenceByUrl.get(url) ?? {
          ranges: [],
          selections: [],
          contents: new Set<string>(),
          contentsByRange: new Map<string, string>(),
        };
        const mergedRangeMap = new Map<string, LineRange>();
        [...existingEvidence.ranges, ...ranges].forEach((range) => {
          mergedRangeMap.set(`${range.start}:${range.end}`, range);
        });
        const mergedSelectionMap = new Map<string, LineSelection>();
        [...existingEvidence.selections, ...selections].forEach((selection) => {
          mergedSelectionMap.set(
            `${selection.start}:${selection.end}:${selection.text}`,
            selection,
          );
        });
        normalizedContents.forEach((content) =>
          existingEvidence.contents.add(content),
        );
        selections.forEach((selection) =>
          existingEvidence.contents.add(selection.text),
        );
        ranges.forEach((range, index) => {
          const content = normalizedContents[index];
          if (typeof content !== "string" || content.length === 0) {
            return;
          }
          existingEvidence.contentsByRange.set(
            `${range.start}:${range.end}`,
            content,
          );
        });
        selections.forEach((selection) => {
          const key = `${selection.start}:${selection.end}`;
          if (!existingEvidence.contentsByRange.has(key)) {
            existingEvidence.contentsByRange.set(key, selection.text);
          }
        });
        extractedEvidenceByUrl.set(url, {
          ranges: Array.from(mergedRangeMap.values()),
          selections: Array.from(mergedSelectionMap.values()),
          contents: existingEvidence.contents,
          contentsByRange: existingEvidence.contentsByRange,
        });
        extracted.push({
          url,
          title,
          pageId,
          lineCount,
          ranges,
          selections,
          contents: normalizedContents,
          broken,
          inrelavate,
          error: errorMessage,
        });
      });
    }
  }

  const searchStructured = await generateText({
    model,
    output: Output.object({
      schema: SearchSubagentFinalSchema,
      name: "search_subagent_result",
      description:
        "Final search-subagent result object with URL items and global errors.",
    }),
    system:
      "Convert the raw search-subagent output into a valid JSON object that strictly matches the schema.",
    prompt: [
      `User query: ${query}`,
      "Raw search-subagent output:",
      lastText,
    ].join("\n\n"),
    abortSignal,
  });
  const parsed = searchStructured.output;
  const normalizedGlobalErrors = [
    ...parsed.errors
      .map((error) => error.trim())
      .filter((error) => error.length > 0),
    ...searchToolErrors,
    ...extractToolErrors,
  ];
  const globalErrorResults = normalizedGlobalErrors.map((error, index) => ({
    url: `search://subagent-error/${index + 1}`,
    title: "Search subagent",
    ranges: [],
    selections: [],
    contents: [],
    broken: true,
    inrelavate: false,
    error,
  })) satisfies SearchResult[];
  const normalized = validateNormalizedSearchResultsAgainstExtractedContents(
    query,
    normalizeSearchResults(parsed.results as unknown as JsonValue),
    extractedEvidenceByUrl,
  ).map((item) => {
    const lookup = searchLookup.get(item.url);
    return {
      ...item,
      title: item.title ?? lookup?.title,
    };
  });
  const mergedResults = dedupeSearchResults([
    ...extracted,
    ...normalized,
    ...globalErrorResults,
  ]);
  const hasUsableEvidence = mergedResults.some(
    (item) =>
      !item.error &&
      !(item.broken ?? false) &&
      !(item.inrelavate ?? false) &&
      item.ranges.length > 0 &&
      item.contents.length > 0,
  );
  const allSearchCallsFailed =
    searchToolCallCount > 0 && searchToolErrorCount === searchToolCallCount;
  const allExtractCallsFailed =
    extractToolCallCount > 0 && extractToolErrorCount === extractToolCallCount;
  if ((allSearchCallsFailed || allExtractCallsFailed) && !hasUsableEvidence) {
    const fatalErrors = Array.from(
      new Set(
        [...normalizedGlobalErrors]
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );
    console.warn("[subagent.runSearch.fatalToolFailure]", {
      query,
      allSearchCallsFailed,
      allExtractCallsFailed,
      fatalErrors: fatalErrors.map((entry) => clampText(entry, 180)),
    });
  }
  if (mergedResults.length > 0) {
    console.log("[subagent.runSearch.done]", {
      query,
      results: mergedResults.length,
    });
    return mergedResults;
  }
  console.log("[subagent.runSearch.done]", {
    query,
    results: 0,
  });
  return [];
}

const normalizeKeyText = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const buildDeepSearchReferences = (
  results: SearchResult[],
  projectId: string | undefined,
  searchId: string,
): DeepSearchReference[] => {
  const references: DeepSearchReference[] = [];
  const dedupe = new Set<string>();

  for (const result of results) {
    if ((result.broken ?? false) || (result.inrelavate ?? false)) {
      continue;
    }
    const fallbackSelections = result.contents.map((content) => ({
      start: 1,
      end: 1,
      text: content,
    }));
    const candidates = (
      result.selections.length > 0 ? result.selections : fallbackSelections
    )
      .map((selection) => ({
        start: Math.max(1, selection.start),
        end: Math.max(1, selection.end),
        text: clampText(selection.text.trim(), 1200),
      }))
      .filter((selection) => selection.text.length > 0)
      .slice(0, 3);

    for (const candidate of candidates) {
      const dedupeKey = `${result.url}::${normalizeKeyText(candidate.text)}`;
      if (dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);
      const refId = references.length + 1;
      const uri =
        projectId && searchId
          ? buildDeepResearchRefUri({ projectId, searchId, refId })
          : "";
      references.push({
        refId,
        uri,
        pageId: result.pageId ?? "",
        url: result.url,
        title: result.title,
        startLine: candidate.start,
        endLine: candidate.end,
        text: candidate.text,
      });
    }
  }

  return references;
};

const buildDeepSearchContext = (
  query: string,
  references: DeepSearchReference[],
): string => {
  const context = references
    .map((reference) => {
      const title = reference.title ?? deriveSourceTitle(reference.url);
      return [
        `[${reference.refId}] ${title}`,
        `URL: ${reference.url}`,
        `Lines: ${reference.startLine}-${reference.endLine}`,
        "Excerpt:",
        reference.text,
      ].join("\n");
    })
    .join("\n\n");
  return [
    `Question: ${query}`,
    "Use only the numbered references below.",
    "Every supported claim must include one or more citations like [1].",
    "",
    context,
  ].join("\n");
};

const linkifyCitationMarkers = (
  value: string,
  references: DeepSearchReference[],
): string => {
  const uriById = new Map<number, string>();
  references.forEach((reference) => {
    if (reference.uri) {
      uriById.set(reference.refId, reference.uri);
    }
  });
  if (uriById.size === 0) {
    return value;
  }
  const expandCitationGroup = (group: string): number[] => {
    const compact = group.trim();
    if (!compact) {
      return [];
    }
    const tokens = compact
      .split(/[,\s，、;；]+/)
      .filter((token) => token.length > 0);
    const ids: number[] = [];
    tokens.forEach((token) => {
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = Number.parseInt(rangeMatch[1], 10);
        const end = Number.parseInt(rangeMatch[2], 10);
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          end >= start &&
          end - start <= 8
        ) {
          for (let index = start; index <= end; index += 1) {
            ids.push(index);
          }
        }
        return;
      }
      if (/^\d+$/.test(token)) {
        ids.push(Number.parseInt(token, 10));
      }
    });
    return ids;
  };
  const linkifiedGroups = value.replace(
    /\[([\d,\s，、;；-]+)\](?!\()/g,
    (full, rawGroup: string) => {
      const ids = expandCitationGroup(rawGroup);
      if (ids.length === 0) {
        return full;
      }
      const linked = ids
        .map((refId) => {
          const uri = uriById.get(refId);
          if (!uri) {
            return null;
          }
          return `[${refId}](${uri})`;
        })
        .filter((entry): entry is string => entry !== null);
      if (linked.length === 0) {
        return full;
      }
      return linked.join(", ");
    },
  );
  const linkifiedSingle = linkifiedGroups.replace(
    /\[(\d+)\](?!\()/g,
    (full, rawRefId: string) => {
      const refId = Number.parseInt(rawRefId, 10);
      const uri = uriById.get(refId);
      if (!uri) {
        return full;
      }
      return `[${refId}](${uri})`;
    },
  );
  return linkifiedSingle.replace(/\[\^(\d+)\]/g, (full, rawRefId: string) => {
    const refId = Number.parseInt(rawRefId, 10);
    const uri = uriById.get(refId);
    if (!uri) {
      return full;
    }
    return `[${refId}](${uri})`;
  });
};

async function runDeepSearchTool({
  query,
  model,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
  deepResearchStore,
}: {
  query: string;
  model: LanguageModel;
  writer?: UIMessageStreamWriter;
  toolCallId?: string;
  toolName?: string;
  abortSignal?: AbortSignal;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
}): Promise<{
  conclusion: string;
  sources: DeepSearchSource[];
  references: DeepSearchReference[];
  searchId: string;
  projectId?: string;
  prompt: string;
}> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    const message = "Query is empty after trimming.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
    );
    throw new Error(message);
  }
  const fallbackCreatedAt = new Date().toISOString();
  const searchSession = deepResearchStore
    ? await deepResearchStore.createSearchSession(normalizedQuery)
    : { searchId: `local-${Date.now()}`, createdAt: fallbackCreatedAt };
  const searchId = searchSession.searchId;
  const searchCreatedAt = searchSession.createdAt ?? fallbackCreatedAt;
  const projectId = deepResearchStore?.projectId;
  writeDeepSearchStream(writer, toolCallId, toolName, {
    query: normalizedQuery,
    projectId,
    searchId,
    status: "running",
  });

  try {
    const results = await runSearchSubagent({
      query: normalizedQuery,
      searchId,
      model,
      writer,
      toolCallId,
      toolName: "search",
      abortSignal,
      tavilyApiKey,
      jinaReaderBaseUrl,
      jinaReaderApiKey,
      deepResearchStore,
    });
    const references = buildDeepSearchReferences(results, projectId, searchId);
    const sources = buildDeepSearchSources(results, references);
    writeDeepSearchStream(writer, toolCallId, toolName, {
      query: normalizedQuery,
      projectId,
      searchId,
      sources,
      references,
      status: "running",
    });

    let prompt = "";
    let conclusionRaw = "";
    const sourceErrors = Array.from(
      new Set(
        results
          .map((item) =>
            typeof item.error === "string" ? item.error.trim() : "",
          )
          .filter((error) => error.length > 0),
      ),
    );
    if (sources.length === 0 || references.length === 0) {
      const errorDetails =
        sourceErrors.length > 0
          ? [
              "",
              "Observed tool errors:",
              ...sourceErrors.map((error, index) => `${index + 1}. ${error}`),
              "Explain these failures in user language and suggest practical next steps.",
            ].join("\n")
          : "";
      prompt = [
        `Question: ${normalizedQuery}`,
        "",
        "No validated references are currently available.",
        "Explain the current evidence status and what additional search directions would help.",
        errorDetails,
      ].join("\n");
    } else {
      prompt = buildDeepSearchContext(normalizedQuery, references);
    }
    const result = streamText({
      model,
      system: DEEPSEARCH_SYSTEM,
      prompt,
      abortSignal,
    });
    for await (const delta of result.textStream) {
      conclusionRaw += delta;
      writeDeepSearchStream(writer, toolCallId, toolName, {
        query: normalizedQuery,
        projectId,
        searchId,
        sources,
        references,
        prompt,
        conclusion: linkifyCitationMarkers(conclusionRaw, references),
        status: "running",
      });
    }

    const finalConclusionRaw =
      conclusionRaw.trim() || "No conclusion generated.";
    const finalConclusionLinked = linkifyCitationMarkers(
      finalConclusionRaw,
      references,
    );
    if (deepResearchStore) {
      const persistedReferences: DeepResearchReferenceRecord[] = references.map(
        (reference) => ({
          refId: reference.refId,
          uri: reference.uri,
          pageId: reference.pageId,
          url: reference.url,
          title: reference.title,
          startLine: reference.startLine,
          endLine: reference.endLine,
          text: reference.text,
        }),
      );
      await deepResearchStore.finalizeSearch({
        searchId,
        query: normalizedQuery,
        llmPrompt: prompt,
        llmConclusionRaw: finalConclusionRaw,
        llmConclusionLinked: finalConclusionLinked,
        references: persistedReferences,
        createdAt: searchCreatedAt,
        completedAt: new Date().toISOString(),
      });
    }
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        projectId,
        searchId,
        prompt,
        sources,
        references,
        conclusion: finalConclusionLinked,
        status: "complete",
        complete: true,
      },
      true,
    );

    return {
      conclusion: finalConclusionLinked,
      sources,
      references,
      searchId,
      projectId,
      prompt,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Deep search failed.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        projectId,
        searchId,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
    );
    throw error instanceof Error ? error : new Error(message);
  }
}

export function createTools(
  writer: UIMessageStreamWriter,
  config: ToolConfig = {},
) {
  return {
    deepSearch: tool({
      description:
        "Run deep research via network search and a subagent, returning a concise conclusion with sources.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("User research question to answer with cited evidence."),
      }).describe("Input payload for the deepSearch tool."),
      outputSchema: z.object({
        conclusion: z
          .string()
          .describe("Final concise answer with inline bracket citations."),
        answer: z
          .string()
          .describe("Alias of conclusion for compatibility with existing callers."),
        sources: z.array(
          z.object({
            url: z.string().describe("Source page URL."),
            title: z
              .string()
              .optional()
              .describe("Source title, if available."),
            snippet: z
              .string()
              .optional()
              .describe("Short source summary or preview text."),
            excerpts: z
              .array(
                z
                  .string()
                  .describe("Evidence excerpt used for synthesis/citation."),
              )
              .optional()
              .describe("Selected evidence excerpts from the source page."),
            referenceIds: z
              .array(
                z
                  .number()
                  .int()
                  .positive()
                  .describe("Reference ID pointing into references list."),
              )
              .optional()
              .describe("Reference IDs tied to this source."),
            error: z
              .string()
              .optional()
              .describe("Extraction error for this source when retrieval failed."),
          }).describe("Aggregated source entry used by deep search output."),
        ).describe("Only source pages that are actually used by returned references."),
        references: z.array(
          z.object({
            refId: z
              .number()
              .int()
              .positive()
              .describe("Sequential reference number used in inline citations."),
            uri: z.string().describe("Canonical URI for locating highlighted range."),
            pageId: z
              .string()
              .describe("Persisted page identifier for deep-research page record."),
            url: z.string().describe("Original page URL."),
            title: z
              .string()
              .optional()
              .describe("Page title for display."),
            startLine: z
              .number()
              .int()
              .positive()
              .describe("Inclusive 1-based start line for highlighted reference."),
            endLine: z
              .number()
              .int()
              .positive()
              .describe("Inclusive 1-based end line for highlighted reference."),
            text: z.string().describe("Reference text shown to end users."),
          }).describe("Resolved citation reference entry."),
        ).describe("All numbered references that can be cited as [n]."),
        searchId: z.string().describe("Unique identifier of this deep-search run."),
        projectId: z
          .string()
          .optional()
          .describe("Optional project identifier when search is project-scoped."),
        prompt: z
          .string()
          .describe("Prompt sent to synthesis model for this deep-search run."),
      }).describe("Structured deep-search result returned to the caller."),
      execute: async ({ query }, options) => {
        if (!config.model) {
          throw new Error("DeepSearch tool is not configured with a model.");
        }
        const result = await runDeepSearchTool({
          query,
          model: config.model,
          writer,
          toolCallId: options.toolCallId,
          toolName: "deepSearch",
          abortSignal: options.abortSignal,
          tavilyApiKey: config.tavilyApiKey,
          jinaReaderBaseUrl: config.jinaReaderBaseUrl,
          jinaReaderApiKey: config.jinaReaderApiKey,
          deepResearchStore: config.deepResearchStore,
        });
        return {
          conclusion: result.conclusion,
          answer: result.conclusion,
          sources: result.sources,
          references: result.references,
          searchId: result.searchId,
          projectId: result.projectId,
          prompt: result.prompt,
        };
      },
    }),
  };
}
