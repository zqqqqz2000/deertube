import {
  Output,
  generateText,
  readUIMessageStream,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import type { JsonValue } from "../../../types/json";
import type {
  DeepResearchPersistenceAdapter,
  DeepResearchReferenceRecord,
} from "../../../shared/deepresearch";
import {
  type LineRange,
  type LineSelection,
} from "../../../shared/deepresearch";
import {
  DEEPSEARCH_SYSTEM,
  EXTRACT_SUBAGENT_SYSTEM,
  ExtractSubagentFinalSchema,
  LineRangeSchema,
  LineSelectionSchema,
  noStepLimit,
  SEARCH_SUBAGENT_SYSTEM,
  SearchSubagentFinalSchema,
  TavilySearchResultSchema,
} from "./schemas";
import {
  buildDeepSearchContext,
  buildDeepSearchReferences,
  buildDeepSearchSources,
  buildLineNumberedContentsFromRanges,
  buildSelectionsFromRanges,
  clampText,
  collectToolOutputs,
  dedupeSearchResults,
  extractText,
  fetchJinaReaderMarkdown,
  fetchTavilySearch,
  formatLineNumbered,
  isRecord,
  linkifyCitationMarkers,
  normalizeRanges,
  normalizeSearchResults,
  parseLineRanges,
  parseLineSelections,
  splitLines,
  summarizeContentsPreview,
  summarizeRanges,
  validateNormalizedSearchResultsAgainstExtractedContents,
  writeDeepSearchStream,
  writeSubagentStream,
} from "./helpers";
import type {
  DeepSearchReference,
  DeepSearchSource,
  ExtractedEvidence,
  SearchResult,
  SubagentUIMessage,
} from "./types";

export async function runExtractSubagent({
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
  let lastText = "";
  const extracted: SearchResult[] = [];
  const searchToolErrors: string[] = [];
  const extractToolErrors: string[] = [];
  let searchToolCallCount = 0;
  let searchToolErrorCount = 0;
  let extractToolCallCount = 0;
  let extractToolErrorCount = 0;
  const extractedEvidenceByUrl = new Map<string, ExtractedEvidence>();
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

export async function runDeepSearchTool({
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
