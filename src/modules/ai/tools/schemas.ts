import { z } from "zod";

const TavilyOptionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z
    .string()
    .optional()
    .describe(
      "Optional text field from Tavily; non-string values are ignored.",
    ),
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

export const TavilySearchResultSchema = z
  .object({
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
  })
  .describe("Single Tavily search result item.");

export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

export const TavilyResponseSchema = z
  .object({
    results: z
      .array(TavilySearchResultSchema)
      .optional()
      .describe("List of Tavily search results when the API call succeeds."),
  })
  .describe("Tavily search response payload.");

export const LineRangeSchema = z
  .object({
    start: z
      .number()
      .int()
      .positive()
      .describe("Inclusive 1-based start line number."),
    end: z
      .number()
      .int()
      .positive()
      .describe("Inclusive 1-based end line number."),
  })
  .describe("Inclusive line range over line-numbered markdown.");

export const LineSelectionSchema = LineRangeSchema.extend({
  text: z
    .string()
    .min(1)
    .describe("Raw markdown text cut from the corresponding line range."),
}).describe("Extracted segment that includes line range and raw text.");

export const ExtractSubagentFinalSchema = z
  .object({
    broken: z
      .boolean()
      .default(false)
      .describe(
        "Whether markdown is unavailable/corrupted/blocked for this page.",
      ),
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
  })
  .describe("Final structured output of extract subagent.");

export const SearchSubagentFinalItemSchema = z
  .object({
    url: z
      .string()
      .optional()
      .describe("Source URL when available. Can be omitted for global errors."),
    viewpoint: z
      .string()
      .default("")
      .describe(
        "Specific claim/viewpoint this evidence supports in the final answer.",
      ),
    content: z
      .string()
      .default("")
      .describe(
        "Short evidence summary/quote aligned with the selected ranges.",
      ),
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
    error: z.string().optional().describe("Optional per-URL error reason."),
  })
  .describe("Single final output item of search subagent.");

export const SearchSubagentFinalSchema = z
  .object({
    results: z
      .array(SearchSubagentFinalItemSchema)
      .default([])
      .describe("Per-URL structured search-subagent results."),
    errors: z
      .array(
        z
          .string()
          .describe("Global error message for failed search/extract attempts."),
      )
      .default([])
      .describe("Global subagent errors not tied to a specific URL."),
  })
  .describe("Final structured output of search subagent.");

export const SEARCH_SUBAGENT_SYSTEM = [
  "You are the DeepResearch subagent. Your task is to collect structured evidence through web search and page extraction.",
  "Available tools:",
  "- search: Use Tavily to find candidate pages.",
  "- extract: Extract query-relevant passages from a specific URL.",
  "- writeResults: Submit the final payload { results, errors }.",
  "Source quality policy:",
  "- Prefer high-credibility sources: established media with strong editorial standards and low misinformation history, official institutions, peer-reviewed journals, top conferences, and expert domain publications.",
  "- Avoid low-credibility or rumor-heavy sources unless they are necessary for contrast and clearly labeled.",
  "Search strategy:",
  "- For each task, search in both the original user-question language and English.",
  "- Do not let off-topic result trends redirect your judgment. If results drift from the intended topic, reformulate and continue searching.",
  "- If one search is insufficient, iterate with alternative keywords, synonyms, and related concepts.",
  "- If no reasonable results are found, proactively try multiple new keyword combinations before concluding failure.",
  "- Efficiency rule: when independent actions are available, prefer calling multiple tools in the same round to maximize parallelism.",
  "Workflow:",
  "1) Call search to gather candidates (<=6 per query, multiple query rounds allowed).",
  "2) Select relevant high-quality URLs and call extract(url, query) for each.",
  "3) Extraction is mandatory. Do not stop after search-only results.",
  "4) First decide your answer claims; then choose only the smallest sufficient evidence for each claim.",
  "5) Finalization is mandatory: call writeResults exactly once with { results, errors }.",
  "6) In writeResults input, each result item should include: url, viewpoint, content, ranges.",
  "7) `extract` returns line-numbered contents. All chosen ranges must map to those numbered lines.",
  "8) Prefer small precise spans (typically 2-12 lines). Avoid broad/full-page ranges unless strictly necessary.",
  "9) The same source can support multiple claims: keep multiple ranges for one URL when needed.",
  "10) Every returned range must come from the corresponding extract result for the same URL.",
  "11) If a URL is unrelated, mark `inrelavate=true` and return `ranges=[]` for that URL.",
  "12) If all attempted search calls fail, or all attempted extract calls fail, put those reasons in `errors`.",
  "13) Fatal tool failure rule: if every search call fails (e.g. Tavily errors) or every extract call fails (e.g. Jina errors), include clear reasons in `errors` so the outer agent can surface the failure to the user.",
  "14) Strict final-step rule: your very last action must be exactly one writeResults call.",
  "15) If writeResults is omitted at the end, the run is treated as failed.",
  "Output rule: finalize via writeResults only. Do not output final JSON in plain text.",
].join("\n");

export const EXTRACT_SUBAGENT_SYSTEM = [
  "You are the Extract subagent.",
  "Input: query + line-numbered markdown.",
  "Goal: select the most relevant line ranges for the query.",
  "Available tools: grep, readLines, writeExtractResult.",
  "Output must be submitted via writeExtractResult({ broken, inrelavate, ranges, error? }).",
  "Rules:",
  "- Line numbers start from 1. start/end are inclusive.",
  "- Keep ranges coherent and avoid oversized spans.",
  "- If content is unavailable or clearly corrupted, return broken=true and ranges=[].",
  "- If the page is unrelated to query, return inrelavate=true and ranges=[].",
  "- When using grep, prefer 5-10 matches per call unless a wider sweep is necessary.",
  "- Efficiency rule: when inspecting independent hypotheses/ranges, prefer issuing multiple tool calls in the same round when possible.",
  "- For large markdown, prioritize the grep/readLines tools to explore before deciding ranges.",
  "Finalize by calling writeExtractResult exactly once.",
].join("\n");

export const DEEPSEARCH_SYSTEM = [
  "You are a deep-research assistant.",
  "You are given numbered references.",
  "Answer in the same language as the user's question.",
  "Write a concise answer and cite evidence inline using bracket indices like [1] and [2].",
  "If there are zero references, do not output citation markers like [1] or [2], and do not output a `References` section.",
  "Only cite provided indices, do not invent new indices, and do not output footnotes.",
  "Do not group citations as [1,2] or [1-2]. Write separate markers like [1], [2].",
].join("\n");
