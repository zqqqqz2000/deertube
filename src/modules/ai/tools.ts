import {
  InferUITools,
  UIMessage,
  UIMessageStreamWriter,
  generateText,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";

interface SubagentStreamPayload {
  toolCallId: string;
  toolName?: string;
  messages: UIMessage[];
}

export interface SubagentUIDataParts extends Record<string, unknown> {
  "subagent-stream": SubagentStreamPayload;
}

export type DeertubeUIDataTypes = SubagentUIDataParts;

export type DeertubeUITools = InferUITools<ReturnType<typeof createTools>>;

export type DeertubeUIMessage = UIMessage<unknown, DeertubeUIDataTypes, DeertubeUITools>;

interface ToolConfig {
  model?: LanguageModel;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
}

const TavilySearchResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  raw_content: z.string().optional(),
  snippet: z.string().optional(),
  description: z.string().optional(),
});

type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

const TavilyResponseSchema = z.object({
  results: z.array(TavilySearchResultSchema).optional(),
});

const SEARCH_SUBAGENT_SYSTEM = [
  "你是 DeepResearch 子代理。你的任务是通过检索和抽取网页内容，返回结构化证据。",
  "可用工具:",
  "- search: Tavily 搜索，返回候选结果。",
  "- extract: 对指定 URL 进行内容抽取，返回相关段落。",
  "流程:",
  "1) 调用 search 获取候选结果 (<=6)。",
  "2) 选择高相关结果，逐个调用 extract(url, query)。",
  "3) 输出 JSON 数组，每项: { url, excerpts: string[], broken?: boolean }。",
  "要求: 仅输出 JSON，不要额外解释。",
].join("\n");

const EXTRACT_SUBAGENT_SYSTEM = [
  "你是 Extract 子代理。",
  "输入: 查询词 + 带行号的 Markdown。",
  "目标: 选出与查询最相关的段落行范围。",
  "输出 JSON: { broken: boolean, ranges: [{ start, end }] }。",
  "规则:",
  "- 行号从 1 开始，start/end 为闭区间。",
  "- 保持段落连贯，避免超大范围。",
  "- 如果内容无法获取或明显损坏，broken=true 且 ranges=[]。",
  "- Markdown 很大时，优先使用 grep/readLines 工具探索。",
  "仅输出 JSON。",
].join("\n");

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const extractJsonFromText = (text: string): unknown => {
  const trimmed = text.trim();
  const direct = parseJson(trimmed);
  if (direct) return direct;
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fenced = parseJson(fencedMatch[1].trim());
    if (fenced) return fenced;
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = parseJson(candidate);
    if (parsed) return parsed;
  }
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    const parsed = parseJson(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const writeSubagentStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  messages: UIMessage[],
) => {
  if (!writer || !toolCallId) return;
  writer.write({
    type: "data-subagent-stream",
    id: toolCallId,
    data: { toolCallId, toolName, messages },
  });
};

type AnyUIMessagePart = NonNullable<UIMessage["parts"]>[number];

const isTextPart = (part: AnyUIMessagePart): part is AnyUIMessagePart & { text: string } =>
  part.type === "text" && "text" in part;

const isToolPart = (part: AnyUIMessagePart): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

const getToolName = (part: AnyUIMessagePart): string | undefined => {
  if (part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }
  if (part.type === "dynamic-tool" && "toolName" in part && typeof part.toolName === "string") {
    return part.toolName;
  }
  return undefined;
};

const extractText = (message: UIMessage): string => {
  if (!message.parts) return "";
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
};

const collectToolOutputs = (
  message: UIMessage,
): { name?: string; output: unknown }[] => {
  if (!message.parts) return [];
  return message.parts
    .filter(isToolPart)
    .map((part) => ({
      name: getToolName(part),
      output: "output" in part ? part.output : undefined,
    }))
    .filter((item) => item.output !== undefined);
};

const normalizeRanges = (
  ranges: unknown,
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

const formatLineNumbered = (lines: string[], offset = 0, totalLines?: number): string => {
  const width = String(totalLines ?? lines.length + offset).length;
  return lines
    .map((line, index) => {
      const lineNumber = String(index + 1 + offset).padStart(width, "0");
      return `${lineNumber} | ${line}`;
    })
    .join("\n");
};

const buildExcerptsFromRanges = (
  lines: string[],
  ranges: { start: number; end: number }[],
): string[] => {
  const excerpts = ranges
    .map((range) => lines.slice(range.start - 1, range.end).join("\n").trim())
    .filter((text) => text.length > 0);
  return Array.from(new Set(excerpts));
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
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`);
  }
  const parsed = TavilyResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.results ?? [] : [];
}

async function fetchJinaReaderMarkdown(
  url: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<string> {
  const normalizedBase = baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : "https://r.jina.ai/";
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
  const parsed = parseJson(raw);
  if (parsed === null) {
    return raw;
  }
  if (typeof parsed === "string") {
    return parsed;
  }
  if (typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.content === "string") {
      return obj.content;
    }
    const nested = obj.data;
    if (nested && typeof nested === "object") {
      const nestedContent = (nested as Record<string, unknown>).content;
      if (typeof nestedContent === "string") {
        return nestedContent;
      }
    }
    return JSON.stringify(obj, null, 2);
  }
  return raw;
}

interface SearchResult { url: string; excerpts: string[]; broken?: boolean }

const normalizeSearchResults = (raw: unknown): SearchResult[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!isRecord(item)) return null;
      const url = typeof item.url === "string" ? item.url : "";
      const paragraphs = Array.isArray(item.excerpts)
        ? item.excerpts
        : Array.isArray(item.paragraphs)
          ? item.paragraphs
          : [];
      const excerpts = paragraphs.filter((entry) => typeof entry === "string");
      const broken = typeof item.broken === "boolean" ? item.broken : undefined;
      if (!url || (excerpts.length === 0 && broken !== true)) return null;
      return broken === undefined ? { url, excerpts } : { url, excerpts, broken };
    })
    .filter((item): item is SearchResult => item !== null);
};

const dedupeSearchResults = (
  results: SearchResult[],
): SearchResult[] => {
  const map = new Map<string, SearchResult>();
  for (const item of results) {
    const existing = map.get(item.url);
    if (!existing) {
      map.set(item.url, { ...item, excerpts: [...item.excerpts] });
    } else {
      const merged = Array.from(new Set([...existing.excerpts, ...item.excerpts]));
      map.set(item.url, {
        url: item.url,
        excerpts: merged,
        broken: existing.broken ?? item.broken,
      });
    }
  }
  return Array.from(map.values());
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
}): Promise<{ ranges: { start: number; end: number }[]; broken: boolean }> {
  const lineCount = lines.length;
  if (lineCount === 0) {
    return { ranges: [], broken: true };
  }
  const tooLarge = lineCount > 2200 || lines.join("\n").length > 180000;
  const previewLines = tooLarge ? lines.slice(0, 200) : lines;
  const preview = formatLineNumbered(previewLines, 0, lineCount);
  const sizeNote = tooLarge
    ? `Markdown 太大 (${lineCount} 行)，已截取前 200 行预览。可使用 grep/readLines 查找更多。`
    : `Markdown 总行数: ${lineCount}。`;

  const grepTool = tool({
    description: "在全文中使用正则搜索行，返回命中的行号和上下文。",
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
        return { error: error instanceof Error ? error.message : "Invalid regex" };
      }
      const matches: { line: number; text: string; before: string[]; after: string[] }[] = [];
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
    description: "读取指定行号范围的内容。",
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
    stopWhen: stepCountIs(12),
    abortSignal,
  });

  const parsed = extractJsonFromText(result.text);
  const broken = isRecord(parsed) && typeof parsed.broken === "boolean" ? parsed.broken : false;
  const ranges = normalizeRanges(isRecord(parsed) ? parsed.ranges : undefined, lineCount);
  return { ranges, broken };
}

async function runSearchSubagent({
  query,
  model,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
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
}): Promise<{ url: string; excerpts: string[]; broken?: boolean }[]> {
  const accumulatedMessages: UIMessage[] = [];
  let lastText = "";
  const extracted: { url: string; excerpts: string[]; broken?: boolean }[] = [];

  const searchTool = tool({
    description: "使用 Tavily 搜索网页，返回结果列表。",
    inputSchema: z.object({
      query: z.string().min(1),
      maxResults: z.number().min(1).max(8).optional(),
    }),
    execute: async ({ query: inputQuery, maxResults }) => {
      const results = await fetchTavilySearch(inputQuery, maxResults ?? 6, tavilyApiKey);
      return { results };
    },
  });

  const extractTool = tool({
    description: "读取指定 URL 的网页内容，抽取与查询相关的段落。",
    inputSchema: z.object({
      url: z.string().min(1),
      query: z.string().min(1),
    }),
    execute: async ({ url, query: extractQuery }, options) => {
      let markdown = "";
      let broken = false;
      try {
        markdown = await fetchJinaReaderMarkdown(url, jinaReaderBaseUrl, jinaReaderApiKey);
      } catch {
        broken = true;
      }
      if (!markdown.trim()) {
        broken = true;
      }
      const lines = markdown ? splitLines(markdown) : [];
      if (broken || lines.length === 0) {
        return { url, broken: true, ranges: [], excerpts: [] };
      }
      const { ranges, broken: extractedBroken } = await runExtractSubagent({
        query: extractQuery,
        lines,
        model,
        abortSignal: options.abortSignal,
      });
      const excerpts = buildExcerptsFromRanges(lines, ranges);
      return { url, broken: extractedBroken, ranges, excerpts };
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
    stopWhen: stepCountIs(30),
    abortSignal,
  });

  const stream = result.toUIMessageStream();
  const uiMessages = readUIMessageStream({ stream });

  for await (const uiMessage of uiMessages) {
    const existingIndex = accumulatedMessages.findIndex((item) => item.id === uiMessage.id);
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
        const url = typeof output.output.url === "string" ? output.output.url : "";
        const excerpts = Array.isArray(output.output.excerpts)
          ? output.output.excerpts.filter((item) => typeof item === "string")
          : [];
        const broken =
          typeof output.output.broken === "boolean" ? output.output.broken : undefined;
        if (!url || (excerpts.length === 0 && !broken)) return;
        extracted.push({
          url,
          excerpts,
          broken,
        });
      });
    }
  }

  const parsed = extractJsonFromText(lastText);
  const normalized = normalizeSearchResults(parsed);
  if (normalized.length > 0) {
    return dedupeSearchResults(normalized);
  }
  if (extracted.length > 0) {
    return dedupeSearchResults(extracted);
  }
  return [];
}

export function createTools(writer: UIMessageStreamWriter, config: ToolConfig = {}) {
  return {
    search: tool({
      description: "Search the web and return relevant excerpts from sources.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      execute: async ({ query }, options) => {
        if (!config.model) {
          throw new Error("Search tool is not configured with a model.");
        }
        return runSearchSubagent({
          query,
          model: config.model,
          writer,
          toolCallId: options.toolCallId,
          toolName: "search",
          abortSignal: options.abortSignal,
          tavilyApiKey: config.tavilyApiKey,
          jinaReaderBaseUrl: config.jinaReaderBaseUrl,
          jinaReaderApiKey: config.jinaReaderApiKey,
        });
      },
    }),
  };
}
