import {
  InferUITools,
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
  z.string().optional(),
);

const TavilyOptionalNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" || value === null ? value : undefined),
  z.string().nullable().optional(),
);

const TavilySearchResultSchema = z.object({
  title: TavilyOptionalStringSchema,
  url: TavilyOptionalStringSchema,
  content: TavilyOptionalStringSchema,
  raw_content: TavilyOptionalNullableStringSchema,
  snippet: TavilyOptionalStringSchema,
  description: TavilyOptionalStringSchema,
});

type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

const TavilyResponseSchema = z.object({
  results: z.array(TavilySearchResultSchema).optional(),
});

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
  "Workflow:",
  "1) Call search to gather candidates (<=6 per query, multiple query rounds allowed).",
  "2) Select relevant high-quality URLs and call extract(url, query) for each.",
  "3) Extraction is mandatory. Do not stop after search-only results.",
  "4) Return a JSON array only: [{ url, excerpts: string[], broken?: boolean }].",
  "Output rule: return JSON only, with no extra prose.",
].join("\n");

const EXTRACT_SUBAGENT_SYSTEM = [
  "You are the Extract subagent.",
  "Input: query + line-numbered markdown.",
  "Goal: select the most relevant line ranges for the query.",
  "Output JSON: { broken: boolean, ranges: [{ start, end }] }.",
  "Rules:",
  "- Line numbers start from 1. start/end are inclusive.",
  "- Keep ranges coherent and avoid oversized spans.",
  "- If content is unavailable or clearly corrupted, return broken=true and ranges=[].",
  "- For large markdown, prioritize the grep/readLines tools to explore before deciding ranges.",
  "Return JSON only.",
].join("\n");

const DEEPSEARCH_SYSTEM = [
  "You are a deep-research assistant.",
  "You are given numbered references.",
  "Write a concise answer and cite evidence inline using bracket indices like [1] and [2].",
  "Only cite provided indices, do not invent new indices, and do not output footnotes.",
  "Do not group citations as [1,2] or [1-2]. Write separate markers like [1], [2].",
].join("\n");

const parseJson = (raw: string): JsonValue => JSON.parse(raw) as JsonValue;

const extractJsonFromText = (
  text: string,
  context: {
    stage: "extract-subagent" | "search-subagent";
    query?: string;
    url?: string;
  },
): JsonValue => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model output is empty; expected JSON.");
  }
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try {
      return parseJson(fencedMatch[1].trim());
    } catch (error) {
      console.error("[subagent.json.parse.error]", {
        ...context,
        mode: "fenced-json",
        textLength: trimmed.length,
        rawText: trimmed,
      });
      throw new Error(
        `Model output JSON parse failed (fenced block): ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  }
  try {
    return parseJson(trimmed);
  } catch (error) {
    console.error("[subagent.json.parse.error]", {
      ...context,
      mode: "direct-json",
      textLength: trimmed.length,
      rawText: trimmed,
    });
    throw new Error(
      `Model output JSON parse failed: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
};

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

const buildExcerptsFromSelections = (selections: LineSelection[]): string[] =>
  Array.from(
    new Set(
      selections
        .map((selection) => selection.text)
        .filter((text) => text.length > 0),
    ),
  );

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
  selections: LineSelection[];
  excerpts: string[];
  broken?: boolean;
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
    const paragraphs = Array.isArray(item.excerpts)
      ? item.excerpts
      : Array.isArray(item.paragraphs)
        ? item.paragraphs
        : [];
    const excerpts = paragraphs.filter(
      (entry: unknown): entry is string => typeof entry === "string",
    );
    const selections = parseLineSelections(item.selections);
    const broken = typeof item.broken === "boolean" ? item.broken : undefined;
    if (
      !url ||
      (excerpts.length === 0 && selections.length === 0 && broken !== true)
    ) {
      return;
    }
    const normalizedExcerpts =
      excerpts.length > 0 ? excerpts : buildExcerptsFromSelections(selections);
    normalized.push({
      url,
      title,
      selections,
      excerpts: normalizedExcerpts,
      broken,
    });
  });
  return normalized;
};

const dedupeSearchResults = (results: SearchResult[]): SearchResult[] => {
  const map = new Map<string, SearchResult>();
  for (const item of results) {
    const existing = map.get(item.url);
    if (!existing) {
      map.set(item.url, {
        ...item,
        selections: [...item.selections],
        excerpts: [...item.excerpts],
      });
    } else {
      const mergedExcerpts = Array.from(
        new Set([...existing.excerpts, ...item.excerpts]),
      );
      const selectionMap = new Map<string, LineSelection>();
      [...existing.selections, ...item.selections].forEach((selection) => {
        const key = `${selection.start}:${selection.end}:${selection.text}`;
        selectionMap.set(key, selection);
      });
      const mergedSelections = Array.from(selectionMap.values());
      const hasResolvedContent =
        mergedExcerpts.length > 0 || mergedSelections.length > 0;
      map.set(item.url, {
        url: item.url,
        title: existing.title ?? item.title,
        pageId: existing.pageId ?? item.pageId,
        lineCount: existing.lineCount ?? item.lineCount,
        selections: mergedSelections,
        excerpts: mergedExcerpts,
        broken: hasResolvedContent
          ? undefined
          : (existing.broken ?? item.broken),
      });
    }
  }
  return Array.from(map.values());
};

const clampText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;

const normalizeExcerpts = (excerpts: string[]): string[] => {
  const cleaned = excerpts
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

const buildSnippet = (excerpts: string[]): string => {
  if (excerpts.length === 0) return "";
  return clampText(excerpts.join("\n"), 400);
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
    .filter((item) => !item.broken && item.excerpts.length > 0)
    .map((item) => {
      const excerpts = normalizeExcerpts(item.excerpts);
      const snippet = buildSnippet(excerpts);
      const title =
        item.title ?? deriveSourceTitle(item.url, snippet.split("\n")[0]);
      return {
        url: item.url,
        title,
        snippet,
        excerpts,
        referenceIds: referenceIdsByUrl.get(item.url) ?? [],
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
}): Promise<{ ranges: LineRange[]; broken: boolean; rawModelOutput: string }> {
  const lineCount = lines.length;
  if (lineCount === 0) {
    return {
      ranges: [],
      broken: true,
      rawModelOutput: "Empty markdown input.",
    };
  }
  const tooLarge = lineCount > 2200 || lines.join("\n").length > 180000;
  const previewLines = tooLarge ? lines.slice(0, 200) : lines;
  const preview = formatLineNumbered(previewLines, 0, lineCount);
  const sizeNote = tooLarge
    ? `Markdown is large (${lineCount} lines). Only the first 200 lines are shown. Use grep/readLines to inspect more.`
    : `Total markdown lines: ${lineCount}.`;

  const grepTool = tool({
    description:
      "Search all lines with a regex and return matching line numbers with surrounding context.",
    inputSchema: z.object({
      pattern: z.string(),
      flags: z.string().optional(),
      before: z.number().min(0).max(8).optional(),
      after: z.number().min(0).max(8).optional(),
      maxMatches: z.number().min(1).max(40).optional(),
    }),
    execute: ({ pattern, flags, before = 2, after = 2, maxMatches = 20 }) => {
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
      return { matches, total: matches.length };
    },
  });

  const readLinesTool = tool({
    description: "Read content by a specified inclusive line range.",
    inputSchema: z.object({
      start: z.number().min(1),
      end: z.number().min(1),
    }),
    execute: ({ start, end }) => {
      const safeStart = Math.max(1, Math.min(lineCount, Math.floor(start)));
      const safeEnd = Math.max(safeStart, Math.min(lineCount, Math.floor(end)));
      const slice = lines.slice(safeStart - 1, safeEnd);
      return {
        start: safeStart,
        end: safeEnd,
        lines: formatLineNumbered(slice, safeStart - 1, lineCount),
      };
    },
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

  const parsed = extractJsonFromText(result.text, {
    stage: "extract-subagent",
    query,
  });
  const broken =
    isRecord(parsed) && typeof parsed.broken === "boolean"
      ? parsed.broken
      : false;
  const ranges = normalizeRanges(
    isRecord(parsed) ? parsed.ranges : null,
    lineCount,
  );
  return { ranges, broken, rawModelOutput: result.text };
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
  const searchLookup = new Map<string, { title?: string; snippet?: string }>();

  const searchTool = tool({
    description:
      "Search the web via Tavily and return ranked candidate results.",
    inputSchema: z.object({
      query: z.string().min(1),
    }),
    execute: async ({ query: inputQuery }) => {
      console.log("[subagent.search]", {
        query: inputQuery,
        maxResults: 20,
      });
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
    },
  });

  const extractTool = tool({
    description:
      "Fetch markdown from a URL and extract passages relevant to the query.",
    inputSchema: z.object({
      url: z.string().min(1),
      query: z.string().min(1),
    }),
    execute: async ({ url, query: extractQuery }, options) => {
      console.log("[subagent.extract]", {
        url,
        query: extractQuery,
      });
      const lookup = searchLookup.get(url);
      const markdown = await fetchJinaReaderMarkdown(
        url,
        jinaReaderBaseUrl,
        jinaReaderApiKey,
      );
      if (!markdown.trim()) {
        throw new Error("Jina content unavailable.");
      }
      const fetchedAt = new Date().toISOString();
      const lines = splitLines(markdown);
      let pageId: string | undefined;
      let lineCount = lines.length;
      if (deepResearchStore) {
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
      }

      const {
        ranges,
        broken: extractedBroken,
        rawModelOutput,
      } = await runExtractSubagent({
        query: extractQuery,
        lines,
        model,
        abortSignal: options.abortSignal,
      });
      const selections = buildSelectionsFromRanges(lines, ranges);
      const excerpts = buildExcerptsFromSelections(selections);
      if (deepResearchStore && pageId) {
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
      }
      console.log("[subagent.extract.done]", {
        url,
        broken: extractedBroken,
        ranges: ranges.length,
        excerpts: excerpts.length,
      });
      const result = {
        url,
        title: lookup?.title,
        pageId,
        lineCount,
        broken: extractedBroken,
        ranges,
        selections,
        excerpts,
        rawModelOutput,
      };
      console.log("[subagent.extract.result]", result);
      return result;
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
        if (output.name !== "extract") return;
        if (!isRecord(output.output)) return;
        const url =
          typeof output.output.url === "string" ? output.output.url : "";
        const excerpts = Array.isArray(output.output.excerpts)
          ? output.output.excerpts.filter(
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
        if (
          !url ||
          (excerpts.length === 0 && selections.length === 0 && !broken)
        )
          return;
        extracted.push({
          url,
          title,
          pageId,
          lineCount,
          selections,
          excerpts:
            excerpts.length > 0
              ? excerpts
              : buildExcerptsFromSelections(selections),
          broken,
        });
      });
    }
  }

  const parsed = extractJsonFromText(lastText, {
    stage: "search-subagent",
    query,
  });
  const normalized = normalizeSearchResults(parsed).map((item) => {
    const lookup = searchLookup.get(item.url);
    return {
      ...item,
      title: item.title ?? lookup?.title,
    };
  });
  const mergedResults = dedupeSearchResults([...extracted, ...normalized]);
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
    if (result.broken) {
      continue;
    }
    const fallbackSelections = result.excerpts.map((excerpt) => ({
      start: 1,
      end: 1,
      text: excerpt,
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
    if (sources.length === 0 || references.length === 0) {
      prompt = `Question: ${normalizedQuery}\n\nNo references available.`;
      conclusionRaw = "No relevant sources found.";
    } else {
      prompt = buildDeepSearchContext(normalizedQuery, references);
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
        query: z.string().min(1),
      }),
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
