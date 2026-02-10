import {
  hasToolCall,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import type { JsonValue } from "../../../../types/json";
import type {
  DeepResearchPersistenceAdapter,
  LineRange,
  LineSelection,
} from "../../../../shared/deepresearch";
import {
  LineRangeSchema,
  LineSelectionSchema,
  SEARCH_SUBAGENT_SYSTEM,
  SearchSubagentFinalSchema,
  TavilySearchResultSchema,
} from "../schemas";
import {
  buildSelectionsFromRanges,
  clampText,
  collectToolOutputs,
  dedupeSearchResults,
  fetchJinaReaderMarkdown,
  fetchTavilySearch,
  intersectRanges,
  isRecord,
  normalizeSearchResults,
  parseLineRanges,
  parseLineSelections,
  splitLines,
  summarizeContentsPreview,
  summarizeRanges,
  validateNormalizedSearchResultsAgainstExtractedContents,
  writeSubagentStream,
} from "../helpers";
import type {
  ExtractedEvidence,
  SearchResult,
  SubagentUIMessage,
} from "../types";
import { runExtractSubagent } from "./extract-subagent";

const SEARCH_SUBAGENT_MAX_STEPS = 16;
const SEARCH_TOOL_MAX_CALLS = 4;
const EXTRACT_TOOL_MAX_CALLS = 10;
const MAX_REPEAT_SEARCH_QUERY = 2;
const MAX_REPEAT_EXTRACT_URL = 2;

const normalizeToolKey = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();
type SearchSubagentFinalPayload = z.infer<typeof SearchSubagentFinalSchema>;
interface ExtractedUrlMeta {
  title?: string;
  pageId?: string;
  lineCount?: number;
  broken?: boolean;
  inrelavate?: boolean;
  error?: string;
}
const uniqueTrimmedStrings = (values: string[]): string[] => {
  const dedupe = new Set<string>();
  values.forEach((value) => {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return;
    }
    dedupe.add(normalized);
  });
  return Array.from(dedupe.values());
};

export async function runSearchSubagent({
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
  const accumulatedMessages: SubagentUIMessage[] = [];
  const searchToolErrors: string[] = [];
  const extractToolErrors: string[] = [];
  let searchToolCallCount = 0;
  let searchToolErrorCount = 0;
  let extractToolCallCount = 0;
  let extractToolErrorCount = 0;
  let writeResultsCallCount = 0;
  let collectedFinalPayload: SearchSubagentFinalPayload | undefined;
  const searchCallCountByQuery = new Map<string, number>();
  const extractCallCountByUrl = new Map<string, number>();
  const extractedEvidenceByUrl = new Map<string, ExtractedEvidence>();
  const extractedMetaByUrl = new Map<string, ExtractedUrlMeta>();
  const searchLookup = new Map<string, { title?: string; snippet?: string }>();

  const searchTool = tool({
    description:
      "Search the web via Tavily and return ranked candidate results.",
    inputSchema: z
      .object({
        query: z.string().min(1).describe("Natural-language web search query."),
      })
      .describe("Input payload for Tavily web search."),
    outputSchema: z
      .object({
        results: z
          .array(TavilySearchResultSchema)
          .describe("Ranked Tavily search results."),
        error: z
          .string()
          .optional()
          .describe("Search error reason when this tool call fails."),
      })
      .describe("Tavily search tool output."),
    execute: async ({ query: inputQuery }) => {
      searchToolCallCount += 1;
      const normalizedQuery = normalizeToolKey(inputQuery);
      const repeatedSearchCalls =
        (searchCallCountByQuery.get(normalizedQuery) ?? 0) + 1;
      searchCallCountByQuery.set(normalizedQuery, repeatedSearchCalls);
      if (searchToolCallCount > SEARCH_TOOL_MAX_CALLS) {
        const message = `search call budget exceeded (${SEARCH_TOOL_MAX_CALLS}).`;
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        return { results: [], error: message };
      }
      if (repeatedSearchCalls > MAX_REPEAT_SEARCH_QUERY) {
        const message = `repeated search query blocked (${MAX_REPEAT_SEARCH_QUERY}x max): ${inputQuery}`;
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        return { results: [], error: message };
      }
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

  const ExtractToolOutputSchema = z
    .object({
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
        .describe(
          "Relevant inclusive line ranges selected by extract subagent.",
        ),
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
        .describe(
          "Line-numbered extracted content chunks used by search subagent.",
        ),
      error: z
        .string()
        .optional()
        .describe(
          "Extraction error message when this URL cannot be extracted.",
        ),
      rawModelOutput: z
        .string()
        .describe("Raw text output returned by extract subagent model."),
    })
    .describe("Extraction result for one URL.");

  const extractTool = tool({
    description:
      "Fetch markdown from a URL and extract passages relevant to the query.",
    inputSchema: z
      .object({
        url: z
          .string()
          .min(1)
          .describe("Target page URL to fetch and extract from."),
        query: z
          .string()
          .min(1)
          .describe("User query used to locate relevant passages."),
      })
      .describe("Input payload for single-URL extraction."),
    outputSchema: ExtractToolOutputSchema,
    execute: async (
      { url, query: extractQuery },
      options,
    ): Promise<z.infer<typeof ExtractToolOutputSchema>> => {
      extractToolCallCount += 1;
      const normalizedUrl = normalizeToolKey(url);
      const repeatedExtractCalls =
        (extractCallCountByUrl.get(normalizedUrl) ?? 0) + 1;
      extractCallCountByUrl.set(normalizedUrl, repeatedExtractCalls);
      if (extractToolCallCount > EXTRACT_TOOL_MAX_CALLS) {
        const errorMessage = `extract call budget exceeded (${EXTRACT_TOOL_MAX_CALLS}).`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        return {
          url,
          title: searchLookup.get(url)?.title,
          pageId: undefined,
          lineCount: 0,
          broken: true,
          inrelavate: false,
          ranges: [],
          selections: [],
          contents: [],
          error: errorMessage,
          rawModelOutput: "",
        };
      }
      if (repeatedExtractCalls > MAX_REPEAT_EXTRACT_URL) {
        const errorMessage = `repeated extract URL blocked (${MAX_REPEAT_EXTRACT_URL}x max): ${url}`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        return {
          url,
          title: searchLookup.get(url)?.title,
          pageId: undefined,
          lineCount: 0,
          broken: true,
          inrelavate: false,
          ranges: [],
          selections: [],
          contents: [],
          error: errorMessage,
          rawModelOutput: "",
        };
      }
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

  const writeResultsTool = tool({
    description:
      "Write the final search-subagent payload with per-URL results and global errors.",
    inputSchema: SearchSubagentFinalSchema.describe(
      "Final search result payload. Call once when evidence collection is complete.",
    ),
    outputSchema: z
      .object({
        recorded: z.literal(true),
        callCount: z.number().int().positive(),
        resultCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative(),
      })
      .describe("Acknowledgement for stored final search payload."),
    execute: ({ results, errors }) => {
      writeResultsCallCount += 1;
      const mergedResults = collectedFinalPayload
        ? [...collectedFinalPayload.results, ...results]
        : [...results];
      const mergedErrors = collectedFinalPayload
        ? uniqueTrimmedStrings([...collectedFinalPayload.errors, ...errors])
        : uniqueTrimmedStrings(errors);
      const dedupeByKey = new Map<string, SearchSubagentFinalPayload["results"][number]>();
      mergedResults.forEach((item) => {
        const url = typeof item.url === "string" ? item.url : "";
        const key = `${url}|${item.viewpoint}|${item.content}|${item.ranges
          .map((range) => `${range.start}:${range.end}`)
          .join(",")}|${String(item.broken)}|${String(item.inrelavate)}|${
          item.error ?? ""
        }`;
        dedupeByKey.set(key, item);
      });
      collectedFinalPayload = {
        results: Array.from(dedupeByKey.values()),
        errors: mergedErrors,
      };
      console.log("[subagent.runSearch.writeResults]", {
        callCount: writeResultsCallCount,
        inputResultCount: results.length,
        inputErrorCount: errors.length,
        mergedResultCount: collectedFinalPayload.results.length,
        mergedErrorCount: collectedFinalPayload.errors.length,
        sampleUrls: collectedFinalPayload.results
          .slice(0, 5)
          .map((item) => item.url ?? "unknown"),
      });
      return {
        recorded: true,
        callCount: writeResultsCallCount,
        resultCount: collectedFinalPayload.results.length,
        errorCount: collectedFinalPayload.errors.length,
      };
    },
  });

  const searchSubagentPrompt = [
    `User question: ${query}`,
    "Plan the final answer first, then output only the evidence references needed to support it.",
    "Each result item must include: url, viewpoint, content, ranges.",
    "Ranges must be precise and minimal. Avoid broad/full-page ranges unless strictly necessary.",
    "When one source supports multiple points, keep multiple small ranges under the same URL.",
    "The extract tool returns line-numbered contents. Your ranges must be anchored to those line numbers.",
    "Efficiency: when tasks are independent, prefer issuing multiple tool calls in the same round.",
    `Budget: at most ${SEARCH_TOOL_MAX_CALLS} search calls and ${EXTRACT_TOOL_MAX_CALLS} extract calls.`,
    `Do not repeat the same search query more than ${MAX_REPEAT_SEARCH_QUERY} times.`,
    `Do not extract the same URL more than ${MAX_REPEAT_EXTRACT_URL} times.`,
    "Finalization rule (strict): your very last step must be exactly one `writeResults` call.",
    "If `writeResults` is not called at the end, the run is treated as failed.",
    "When evidence is sufficient, call `writeResults` exactly once with { results, errors }.",
  ].join("\n");

  const result = streamText({
    model,
    system: SEARCH_SUBAGENT_SYSTEM,
    prompt: searchSubagentPrompt,
    tools: {
      search: searchTool,
      extract: extractTool,
      writeResults: writeResultsTool,
    },
    toolChoice: "auto",
    stopWhen: [
      hasToolCall("writeResults"),
      stepCountIs(SEARCH_SUBAGENT_MAX_STEPS),
    ],
    abortSignal,
  });

  const stream = result.toUIMessageStream<SubagentUIMessage>();
  const uiMessages = readUIMessageStream<SubagentUIMessage>({ stream });

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
        const errorMessage =
          typeof output.output.error === "string"
            ? output.output.error.trim()
            : undefined;
        const title =
          typeof output.output.title === "string" &&
          output.output.title.trim().length > 0
            ? output.output.title.trim()
            : undefined;
        const pageId =
          typeof output.output.pageId === "string" &&
          output.output.pageId.trim().length > 0
            ? output.output.pageId.trim()
            : undefined;
        const lineCount =
          typeof output.output.lineCount === "number" &&
          Number.isFinite(output.output.lineCount) &&
          output.output.lineCount >= 0
            ? Math.floor(output.output.lineCount)
            : undefined;
        const broken =
          typeof output.output.broken === "boolean"
            ? output.output.broken
            : undefined;
        const inrelavate =
          typeof output.output.inrelavate === "boolean"
            ? output.output.inrelavate
            : undefined;
        if (url) {
          const existingMeta = extractedMetaByUrl.get(url) ?? {};
          extractedMetaByUrl.set(url, {
            title: existingMeta.title ?? title ?? searchLookup.get(url)?.title,
            pageId: existingMeta.pageId ?? pageId,
            lineCount: existingMeta.lineCount ?? lineCount,
            broken: (existingMeta.broken ?? false) || (broken ?? false),
            inrelavate:
              (existingMeta.inrelavate ?? false) || (inrelavate ?? false),
            error: existingMeta.error ?? errorMessage,
          });
        }
        if (errorMessage && errorMessage.trim().length > 0) {
          extractToolErrors.push(errorMessage.trim());
        }
        const normalizedContents = contents;
        if (
          !url ||
          (ranges.length === 0 &&
            normalizedContents.length === 0 &&
            selections.length === 0 &&
            !errorMessage)
        ) {
          return;
        }
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
      });
    }
  }

  if (!collectedFinalPayload) {
    console.warn("[subagent.runSearch.missingFinalToolCall]", {
      query,
      searchToolCallCount,
      extractToolCallCount,
    });
  }

  const toSortedUniqueRanges = (ranges: LineRange[]): LineRange[] => {
    const dedupe = new Map<string, LineRange>();
    ranges.forEach((range) => {
      dedupe.set(`${range.start}:${range.end}`, range);
    });
    return Array.from(dedupe.values()).sort((a, b) =>
      a.start === b.start ? a.end - b.end : a.start - b.start,
    );
  };

  const buildFallbackPayloadFromExtractHistory =
    (): SearchSubagentFinalPayload => {
      const results: SearchSubagentFinalPayload["results"] = [];
      const urls = new Set<string>([
        ...Array.from(extractedEvidenceByUrl.keys()),
        ...Array.from(extractedMetaByUrl.keys()),
      ]);
      urls.forEach((url) => {
        const evidence = extractedEvidenceByUrl.get(url);
        const meta = extractedMetaByUrl.get(url);
        const ranges = toSortedUniqueRanges(evidence?.ranges ?? []);
        const hasEvidence =
          ranges.length > 0 ||
          (evidence?.selections.length ?? 0) > 0 ||
          (evidence?.contents.size ?? 0) > 0;
        const error = meta?.error?.trim();
        const broken = meta?.broken;
        const inrelavate = meta?.inrelavate;
        if (!hasEvidence && !broken && !inrelavate && !error) {
          return;
        }
        results.push({
          url,
          viewpoint: "",
          content: "",
          ranges,
          broken,
          inrelavate,
          error,
        });
      });
      const errors: string[] = [];
      if (results.length === 0) {
        errors.push(
          "search subagent did not call writeResults before finishing and no extract history was available.",
        );
      } else {
        errors.push(
          "search subagent did not call writeResults before finishing; used extract-history fallback.",
        );
      }
      return { results, errors };
    };

  const parsed =
    collectedFinalPayload ?? buildFallbackPayloadFromExtractHistory();

  const enforceWriteResultsConsistency = (
    candidate: SearchResult[],
  ): { normalized: SearchResult[]; errors: string[] } => {
    const errors: string[] = [];
    const extractedUrls = new Set<string>([
      ...Array.from(extractedEvidenceByUrl.keys()),
      ...Array.from(extractedMetaByUrl.keys()),
    ]);
    const normalized = candidate.flatMap((item) => {
      if (!extractedUrls.has(item.url)) {
        errors.push(
          `writeResults returned URL that was never extracted: ${item.url}`,
        );
        return [];
      }
      if (
        (item.broken ?? false) ||
        (item.inrelavate ?? false) ||
        item.ranges.length === 0
      ) {
        return [item];
      }
      const evidence = extractedEvidenceByUrl.get(item.url);
      if (!evidence || evidence.ranges.length === 0) {
        errors.push(
          `writeResults returned ranges but no extracted ranges exist for URL: ${item.url}`,
        );
        return [];
      }
      const intersectionMap = new Map<string, LineRange>();
      item.ranges.forEach((candidateRange) => {
        evidence.ranges.forEach((extractedRange) => {
          const overlap = intersectRanges(candidateRange, extractedRange);
          if (!overlap) {
            return;
          }
          intersectionMap.set(`${overlap.start}:${overlap.end}`, overlap);
        });
      });
      if (intersectionMap.size === 0) {
        errors.push(
          `writeResults returned non-overlapping ranges for URL: ${item.url}; dropped this result item.`,
        );
        return [];
      }
      const intersectedRanges = toSortedUniqueRanges(
        Array.from(intersectionMap.values()),
      );
      const originalRanges = toSortedUniqueRanges(item.ranges);
      const changedByIntersection =
        intersectedRanges.length !== originalRanges.length ||
        intersectedRanges.some((range, index) => {
          const original = originalRanges[index];
          return (
            !original ||
            range.start !== original.start ||
            range.end !== original.end
          );
        });
      if (changedByIntersection) {
        errors.push(
          `writeResults ranges clipped to extracted subset for URL: ${item.url}`,
        );
      }
      return [{ ...item, ranges: intersectedRanges }];
    });
    return { normalized, errors };
  };

  let toolResultsNormalized: SearchResult[] = [];
  try {
    toolResultsNormalized = normalizeSearchResults(
      parsed.results as unknown as JsonValue,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    searchToolErrors.push(`writeResults payload parse failed: ${message}`);
  }
  const {
    normalized: checkedToolResults,
    errors: writeResultsConsistencyErrors,
  } = enforceWriteResultsConsistency(toolResultsNormalized);
  const normalizedGlobalErrors = [
    ...parsed.errors
      .map((error) => error.trim())
      .filter((error) => error.length > 0),
    ...writeResultsConsistencyErrors,
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
    checkedToolResults,
    extractedEvidenceByUrl,
  ).map((item) => {
    const lookup = searchLookup.get(item.url);
    const extractedMeta = extractedMetaByUrl.get(item.url);
    return {
      ...item,
      title: item.title ?? extractedMeta?.title ?? lookup?.title,
      pageId: item.pageId ?? extractedMeta?.pageId,
      lineCount: item.lineCount ?? extractedMeta?.lineCount,
      broken: item.broken ?? extractedMeta?.broken,
      inrelavate: item.inrelavate ?? extractedMeta?.inrelavate,
      error: item.error ?? extractedMeta?.error,
    };
  });
  const mergedResults = dedupeSearchResults([
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
