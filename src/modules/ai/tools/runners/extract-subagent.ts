import { Output, generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { JsonValue } from "../../../../types/json";
import type { LineRange } from "../../../../shared/deepresearch";
import {
  EXTRACT_SUBAGENT_SYSTEM,
  ExtractSubagentFinalSchema,
} from "../schemas";
import {
  buildLineNumberedContentsFromRanges,
  clampText,
  formatLineNumbered,
  normalizeRanges,
  summarizeContentsPreview,
  summarizeRanges,
} from "../helpers";

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
  const EXTRACT_SUBAGENT_MAX_STEPS = 18;
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
    inputSchema: z
      .object({
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
      })
      .describe("Input arguments for line-level regex grep."),
    outputSchema: z
      .object({
        matches: z
          .array(
            z.object({
              line: z.number().int().positive().describe("1-based line number of match."),
              text: z.string().describe("Exact line text that matched the pattern."),
              before: z
                .array(
                  z.string().describe("Context line prefixed with its line number."),
                )
                .describe("Context lines before the matched line."),
              after: z
                .array(
                  z.string().describe("Context line prefixed with its line number."),
                )
                .describe("Context lines after the matched line."),
            }),
          )
          .describe("Matched lines with local context."),
        total: z
          .number()
          .int()
          .nonnegative()
          .describe("Total number of matches returned."),
      })
      .describe("Grep output payload for extract subagent exploration."),
    execute: ({ pattern, flags, before = 2, after = 2, maxMatches = 20 }) => {
      grepCallCount += 1;
      const shouldLogGrepDetail = grepCallCount <= 5 || grepCallCount % 10 === 0;
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
    inputSchema: z
      .object({
        start: z
          .number()
          .min(1)
          .describe("Requested inclusive 1-based start line."),
        end: z.number().min(1).describe("Requested inclusive 1-based end line."),
      })
      .describe("Input arguments for reading a block of line-numbered markdown."),
    outputSchema: z
      .object({
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
      })
      .describe("Read-lines output with normalized bounds and text."),
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
    stopWhen: stepCountIs(EXTRACT_SUBAGENT_MAX_STEPS),
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
