import type { UIMessageStreamWriter } from "ai";
import type { JsonObject, JsonValue } from "../../../types/json";
import { isJsonObject } from "../../../types/json";
import {
  buildDeepResearchRefUri,
  type LineRange,
  type LineSelection,
} from "../../../shared/deepresearch";
import { TavilyResponseSchema, type TavilySearchResult } from "./schemas";
import type {
  DeepSearchReference,
  DeepSearchSource,
  ExtractedEvidence,
  SearchResult,
  SubagentUIMessage,
} from "./types";

export const parseJson = (raw: string): JsonValue =>
  JSON.parse(raw) as JsonValue;

export const isRecord = (value: unknown): value is JsonObject =>
  isJsonObject(value);

export const writeSubagentStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  messages: SubagentUIMessage[],
) => {
  if (!writer || !toolCallId) return;
  writer.write({
    type: "data-subagent-stream",
    id: toolCallId,
    data: { toolCallId, toolName, messages },
  });
};

export const writeDeepSearchStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  payload: {
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
  },
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

type AnyUIMessagePart = NonNullable<SubagentUIMessage["parts"]>[number];

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

export const extractText = (message: SubagentUIMessage): string => {
  if (!message.parts) return "";
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
};

export const collectToolOutputs = (
  message: SubagentUIMessage,
): { name?: string; output: unknown }[] => {
  if (!message.parts) return [];
  return message.parts.filter(isToolPart).flatMap((part) => {
    if (!("output" in part) || part.output === undefined) {
      return [];
    }
    return [
      {
        name: getToolName(part),
        output: part.output as unknown,
      },
    ];
  });
};

export const normalizeRanges = (
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

export const splitLines = (markdown: string): string[] =>
  markdown.split(/\r?\n/);

export const formatLineNumbered = (
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

export const buildSelectionsFromRanges = (
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

export const buildLineNumberedContentsFromRanges = (
  lines: string[],
  ranges: LineRange[],
): string[] => {
  const unique = new Map<string, string>();
  ranges.forEach((range) => {
    const slice = lines.slice(range.start - 1, range.end);
    const text = formatLineNumbered(
      slice,
      range.start - 1,
      lines.length,
    ).trim();
    if (!text) {
      return;
    }
    unique.set(`${range.start}:${range.end}`, text);
  });
  return Array.from(unique.values());
};

export const parseLineSelections = (value: unknown): LineSelection[] => {
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

export const parseLineRanges = (value: unknown): LineRange[] => {
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

const isRangeContainedBy = (
  candidate: LineRange,
  container: LineRange,
): boolean =>
  candidate.start >= container.start && candidate.end <= container.end;

export const intersectRanges = (
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

export const deriveNumberedContentForRange = (
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
        return (
          Number.isFinite(lineNo) &&
          lineNo >= target.start &&
          lineNo <= target.end
        );
      });
    if (selectedLines.length > 0) {
      return selectedLines.join("\n");
    }
  }
  return undefined;
};

export const stripLineNumbers = (numbered: string): string =>
  numbered
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

export const summarizeRanges = (ranges: LineRange[], limit = 6): string[] =>
  ranges.slice(0, limit).map((range) => `${range.start}-${range.end}`);

export const clampText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;

export const summarizeContentsPreview = (
  contents: string[],
  limit = 2,
): string[] =>
  contents.slice(0, limit).map((content) => clampText(content, 180));

export async function fetchTavilySearch(
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

export async function fetchJinaReaderMarkdown(
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

export const normalizeSearchResults = (raw: JsonValue): SearchResult[] => {
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
    const viewpoint =
      typeof item.viewpoint === "string" ? item.viewpoint.trim() : undefined;
    const content =
      typeof item.content === "string" ? item.content.trim() : undefined;
    const ranges = parseLineRanges(item.ranges);
    const broken = typeof item.broken === "boolean" ? item.broken : undefined;
    const inrelavate =
      typeof item.inrelavate === "boolean" ? item.inrelavate : undefined;
    const error = typeof item.error === "string" ? item.error : undefined;
    if (
      !url ||
      (ranges.length === 0 && broken !== true && inrelavate !== true && !error)
    ) {
      return;
    }
    normalized.push({
      url,
      title,
      viewpoint,
      content,
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

export const dedupeSearchResults = (
  results: SearchResult[],
): SearchResult[] => {
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
        viewpoint:
          existing.viewpoint && existing.viewpoint.length > 0
            ? existing.viewpoint
            : item.viewpoint,
        content:
          existing.content && existing.content.length > 0
            ? existing.content
            : item.content,
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

export const validateNormalizedSearchResultsAgainstExtractedContents = (
  query: string,
  normalized: SearchResult[],
  extractedEvidenceByUrl: Map<string, ExtractedEvidence>,
): SearchResult[] =>
  normalized.flatMap((item) => {
    if (item.broken ?? false) {
      return [
        {
          ...item,
          ranges: [],
          selections: [],
          contents: [],
        },
      ];
    }
    if (item.inrelavate ?? false) {
      return [
        {
          ...item,
          ranges: [],
          selections: [],
          contents: [],
        },
      ];
    }
    const evidence = extractedEvidenceByUrl.get(item.url);
    if (!evidence || evidence.ranges.length === 0) {
      if (item.ranges.length === 0) {
        return [
          {
            ...item,
            selections: [],
            contents: [],
          },
        ];
      }
      console.warn("[subagent.search.validate.drop.noEvidence]", {
        query,
        url: item.url,
        ranges: item.ranges.length,
      });
      return [];
    }
    if (item.ranges.length === 0) {
      return [
        {
          ...item,
          selections: [],
          contents: [],
        },
      ];
    }
    const rangeKey = (range: LineRange): string =>
      `${range.start}:${range.end}`;
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
    const convergedRanges = Array.from(convergedRangeMap.values()).sort(
      (a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start),
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
            resolvedSelectionsMap.set(`${range.start}:${range.end}:${text}`, {
              start: range.start,
              end: range.end,
              text,
            });
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
    const resolvedRanges = Array.from(resolvedRangesMap.values()).sort(
      (a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start),
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
    return [
      {
        ...item,
        ranges: resolvedRanges,
        selections: resolvedSelections,
        contents,
      },
    ];
  });

export const normalizeContents = (contents: string[]): string[] => {
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

export const deriveSourceTitle = (url: string, fallback?: string): string => {
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

export const buildDeepSearchSources = (
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
      const viewpoint =
        typeof item.viewpoint === "string" && item.viewpoint.trim().length > 0
          ? clampText(item.viewpoint.trim(), 240)
          : undefined;
      const content =
        typeof item.content === "string" && item.content.trim().length > 0
          ? clampText(item.content.trim(), 320)
          : undefined;
      if (item.error) {
        const title = item.title ?? deriveSourceTitle(item.url, item.url);
        return {
          url: item.url,
          title,
          snippet: `Extraction error: ${clampText(item.error, 260)}`,
          error: item.error,
          excerpts: [],
          referenceIds,
          viewpoint,
          content,
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
        viewpoint,
        content,
        error: item.error,
      };
    });
};

const normalizeKeyText = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

export const buildDeepSearchReferences = (
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

export const buildDeepSearchContext = (
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

export const linkifyCitationMarkers = (
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
      .split(/[\s,，、;；]+/)
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
    /\[([\d\s,，、;；-]+)\](?!\()/g,
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
