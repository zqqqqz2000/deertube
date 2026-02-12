import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import type { LineSelection } from "../../../../shared/deepresearch";
import {
  EXTRACT_SUBAGENT_SYSTEM,
  ExtractSubagentFinalSchema,
} from "../schemas";
import {
  buildSelectionsFromBounds,
  clampText,
  formatLineNumbered,
  summarizeContentsPreview,
  summarizeSelections,
} from "../helpers";

const EXTRACT_VIEWPOINT_MIN = 50;
const EXTRACT_VIEWPOINT_MAX = 100;
const EXTRACT_VIEWPOINT_FILLER =
  "This source needs additional validation before it can support a reliable claim for the query.";
const EXTRACT_VIEWPOINT_FALLBACK =
  "Extraction halted early; this source cannot yet provide a reliable, query-grounded viewpoint.";

const normalizeExtractViewpoint = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (
    compact.length >= EXTRACT_VIEWPOINT_MIN &&
    compact.length <= EXTRACT_VIEWPOINT_MAX
  ) {
    return compact;
  }
  if (compact.length > EXTRACT_VIEWPOINT_MAX) {
    return compact.slice(0, EXTRACT_VIEWPOINT_MAX).trimEnd();
  }
  const expanded =
    compact.length > 0
      ? `${compact} ${EXTRACT_VIEWPOINT_FILLER}`
      : EXTRACT_VIEWPOINT_FALLBACK;
  const normalizedExpanded = expanded.replace(/\s+/g, " ").trim();
  if (normalizedExpanded.length <= EXTRACT_VIEWPOINT_MAX) {
    return normalizedExpanded;
  }
  return normalizedExpanded.slice(0, EXTRACT_VIEWPOINT_MAX).trimEnd();
};

const stripMarkdownCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const matched = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!matched) return trimmed;
  return matched[1].trim();
};

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseExtractResultFromJsonText = (
  value: string,
):
  | {
      parsed: z.infer<typeof ExtractSubagentFinalSchema>;
      source: "raw" | "fence-stripped";
    }
  | {
      parsed: null;
      error: string;
      zodError?: string;
      zodCandidate?: string;
    } => {
  const raw = value.trim();
  const stripped = stripMarkdownCodeFence(raw);
  const candidates: { text: string; source: "raw" | "fence-stripped" }[] = [
    { text: raw, source: "raw" },
  ];
  if (stripped !== raw) {
    candidates.push({ text: stripped, source: "fence-stripped" });
  }

  let lastError = "empty JSON output";
  let latestZodError: string | undefined;
  let latestZodCandidate: string | undefined;
  for (const candidate of candidates) {
    if (candidate.text.length === 0) {
      lastError = `${candidate.source}: empty JSON output`;
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(candidate.text);
    } catch (error) {
      lastError = `${candidate.source}: ${
        error instanceof Error ? error.message : "JSON.parse failed"
      }`;
      continue;
    }
    const validated = ExtractSubagentFinalSchema.safeParse(parsedJson);
    if (validated.success) {
      return { parsed: validated.data, source: candidate.source };
    }
    const zodIssueText = formatZodIssues(validated.error);
    latestZodError = `${candidate.source}: ${zodIssueText}`;
    latestZodCandidate = candidate.text;
    lastError = latestZodError;
  }
  return {
    parsed: null,
    error: lastError,
    zodError: latestZodError,
    zodCandidate: latestZodCandidate,
  };
};

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
  viewpoint: string;
  selections: LineSelection[];
  broken: boolean;
  inrelavate: boolean;
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
      viewpoint: normalizeExtractViewpoint(EXTRACT_VIEWPOINT_FALLBACK),
      selections: [],
      broken: true,
      inrelavate: false,
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
  let writeExtractResultCallCount = 0;
  let collectedExtractResult: z.infer<typeof ExtractSubagentFinalSchema> | undefined;

  const grepTool = tool({
    description:
      "Search all lines with a regex and return matching line numbers with surrounding context. Prefer 5-10 matches per call.",
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
          .max(20)
          .optional()
          .describe("Number of context lines to include before each match (default 10)."),
        after: z
          .number()
          .min(0)
          .max(20)
          .optional()
          .describe("Number of context lines to include after each match (default 10)."),
        maxMatches: z
          .number()
          .min(1)
          .max(40)
          .optional()
          .describe("Maximum number of matches returned in one tool call (prefer 5-10)."),
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
    execute: ({ pattern, flags, before = 10, after = 10, maxMatches = 8 }) => {
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
    description: "Read content by a specified inclusive line span.",
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

  const writeExtractResultTool = tool({
    description:
      "Write the final extract result payload. Call this once after exploration is complete.",
    inputSchema: ExtractSubagentFinalSchema.describe(
      "Final extract result payload with flags, selections, and optional error.",
    ),
    outputSchema: z
      .object({
        recorded: z.literal(true),
        callCount: z.number().int().positive(),
        selectionCount: z.number().int().nonnegative(),
      })
      .describe("Acknowledgement for stored extract result payload."),
    execute: ({ viewpoint, broken, inrelavate, selections, error }) => {
      writeExtractResultCallCount += 1;
      collectedExtractResult = {
        viewpoint,
        broken,
        inrelavate,
        selections,
        error,
      };
      console.log("[subagent.extract.agent.writeExtractResult]", {
        callCount: writeExtractResultCallCount,
        viewpoint: clampText(normalizeExtractViewpoint(viewpoint), 120),
        broken,
        inrelavate,
        selectionCount: selections.length,
        selectionSummary: summarizeSelections(selections),
        error: typeof error === "string" ? clampText(error, 220) : undefined,
      });
      return {
        recorded: true,
        callCount: writeExtractResultCallCount,
        selectionCount: selections.length,
      };
    },
  });

  const extractSubagentPrompt = [
    `Query: ${query}`,
    sizeNote,
    "Task:",
    "- Use grep/readLines as needed to locate evidence.",
    "- For grep, prefer returning around 5-10 matches per call unless you need broader coverage.",
    "- Efficiency: if multiple checks are independent, prefer issuing multiple tool calls in the same round.",
    "- You must provide one viewpoint between 50 and 100 characters.",
    "- No matter what, you must call `writeExtractResult`, even when selections is empty.",
    "- When done, call `writeExtractResult` exactly once with { viewpoint, broken, inrelavate, selections, error? }.",
    "- Do not return final JSON in plain text.",
    "",
    "Line-numbered markdown:",
    preview,
  ].join("\n");

  console.log("[subagent.extract.agent.model]", {
    query,
    lineCount,
    tooLarge,
    previewLines: previewLines.length,
  });
  let result = await generateText({
    model,
    system: EXTRACT_SUBAGENT_SYSTEM,
    prompt: extractSubagentPrompt,
    tools: {
      grep: grepTool,
      readLines: readLinesTool,
      writeExtractResult: writeExtractResultTool,
    },
    toolChoice: "auto",
    stopWhen: [
      hasToolCall("writeExtractResult"),
      stepCountIs(EXTRACT_SUBAGENT_MAX_STEPS),
    ],
    abortSignal,
  });
  if (!collectedExtractResult) {
    const retryJsonPromptPrefix = [
      extractSubagentPrompt,
      "",
      "Continuation requirement (mandatory):",
      "- You did not call `writeExtractResult` in the previous attempt.",
      "- Return the final result as JSON directly now.",
      "- Keep viewpoint length between 50 and 100 characters.",
      "",
      "Output format (strict):",
      "- Output exactly one JSON object and nothing else.",
      "- Do not include any explanation text before/after JSON.",
      "- Do not include markdown code fences.",
      '- JSON keys must match exactly: "viewpoint", "broken", "inrelavate", "selections", optional "error".',
      "- `selections` must be an array of objects: { \"start\": number, \"end\": number }.",
      "- `start`/`end` are positive integers and `end` must be >= `start`.",
      "- If the page is unrelated, set inrelavate=true and selections=[].",
      "- If extraction failed or content is broken, set broken=true and selections=[].",
      "",
      "Required JSON shape:",
      '{ "viewpoint": "50-100 chars", "broken": false, "inrelavate": false, "selections": [{ "start": 12, "end": 18 }], "error": "optional error message" }',
    ].join("\n");
    const retryPrompt = [
      retryJsonPromptPrefix,
      "",
      "Previous assistant output (context):",
      result.text.length > 0 ? clampText(result.text, 3200) : "(empty)",
    ].join("\n");
    console.warn("[subagent.extract.agent.retry.writeExtractResult]", {
      query: clampText(query, 160),
      firstAttemptRawLength: result.text.length,
      steps: result.steps.length,
    });
    const retryResult = await generateText({
      model,
      system: EXTRACT_SUBAGENT_SYSTEM,
      prompt: retryPrompt,
      tools: {
        grep: grepTool,
        readLines: readLinesTool,
        writeExtractResult: writeExtractResultTool,
      },
      toolChoice: "auto",
      stopWhen: [
        hasToolCall("writeExtractResult"),
        stepCountIs(EXTRACT_SUBAGENT_MAX_STEPS),
      ],
      abortSignal,
    });
    let continuationResult = retryResult;
    let continuationText = retryResult.text;
    if (!collectedExtractResult) {
      const parsedRetryResult = parseExtractResultFromJsonText(retryResult.text);
      if (parsedRetryResult.parsed) {
        collectedExtractResult = parsedRetryResult.parsed;
        console.log("[subagent.extract.agent.retry.json.parsed]", {
          query: clampText(query, 160),
          source: parsedRetryResult.source,
          viewpoint: clampText(
            normalizeExtractViewpoint(parsedRetryResult.parsed.viewpoint),
            120,
          ),
          broken: parsedRetryResult.parsed.broken,
          inrelavate: parsedRetryResult.parsed.inrelavate,
          selectionCount: parsedRetryResult.parsed.selections.length,
        });
      } else {
        console.warn("[subagent.extract.agent.retry.json.invalid]", {
          query: clampText(query, 160),
          error: clampText(parsedRetryResult.error, 220),
        });
        if (parsedRetryResult.zodError) {
          const repairPrompt = [
            retryJsonPromptPrefix,
            "",
            "Validation feedback from previous JSON (fix all issues):",
            clampText(parsedRetryResult.zodError, 2400),
            "",
            "Previous JSON candidate:",
            parsedRetryResult.zodCandidate
              ? clampText(parsedRetryResult.zodCandidate, 3200)
              : "(none)",
            "",
            "Return corrected JSON only.",
          ].join("\n");
          console.warn("[subagent.extract.agent.retry.json.repair]", {
            query: clampText(query, 160),
            zodError: clampText(parsedRetryResult.zodError, 220),
          });
          const repairResult = await generateText({
            model,
            system: EXTRACT_SUBAGENT_SYSTEM,
            prompt: repairPrompt,
            tools: {
              grep: grepTool,
              readLines: readLinesTool,
              writeExtractResult: writeExtractResultTool,
            },
            toolChoice: "auto",
            stopWhen: [
              hasToolCall("writeExtractResult"),
              stepCountIs(EXTRACT_SUBAGENT_MAX_STEPS),
            ],
            abortSignal,
          });
          if (!collectedExtractResult) {
            const parsedRepairResult = parseExtractResultFromJsonText(
              repairResult.text,
            );
            if (parsedRepairResult.parsed) {
              collectedExtractResult = parsedRepairResult.parsed;
              console.log("[subagent.extract.agent.retry.json.repair.parsed]", {
                query: clampText(query, 160),
                source: parsedRepairResult.source,
                viewpoint: clampText(
                  normalizeExtractViewpoint(parsedRepairResult.parsed.viewpoint),
                  120,
                ),
                broken: parsedRepairResult.parsed.broken,
                inrelavate: parsedRepairResult.parsed.inrelavate,
                selectionCount: parsedRepairResult.parsed.selections.length,
              });
            } else {
              console.warn("[subagent.extract.agent.retry.json.repair.invalid]", {
                query: clampText(query, 160),
                error: clampText(parsedRepairResult.error, 220),
              });
            }
          }
          continuationResult = repairResult;
          continuationText =
            retryResult.text.length > 0
              ? `${retryResult.text}\n\n${repairResult.text}`
              : repairResult.text;
        }
      }
    }
    result = {
      ...continuationResult,
      text:
        result.text.length > 0
          ? `${result.text}\n\n${continuationText}`
          : continuationText,
    };
  }
  console.log("[subagent.extract.agent.raw]", {
    query: clampText(query, 160),
    rawLength: result.text.length,
    rawPreview: clampText(result.text, 240),
  });
  if (!collectedExtractResult) {
    console.warn("[subagent.extract.agent.missingFinalToolCall]", {
      query: clampText(query, 160),
      lineCount,
      steps: result.steps.length,
    });
  }
  const parsed =
    collectedExtractResult ??
    ({
      viewpoint: EXTRACT_VIEWPOINT_FALLBACK,
      broken: true,
      inrelavate: false,
      selections: [],
      error: "extract subagent did not call writeExtractResult before finishing.",
    } satisfies z.infer<typeof ExtractSubagentFinalSchema>);
  const viewpoint = normalizeExtractViewpoint(parsed.viewpoint);
  const broken = parsed.broken;
  const inrelavate = parsed.inrelavate;
  const parsedSelectionBounds = parsed.selections
    .map((selection) => {
      const start = Math.max(1, Math.min(lineCount, Math.floor(selection.start)));
      const end = Math.max(1, Math.min(lineCount, Math.floor(selection.end)));
      if (end < start) {
        return null;
      }
      return { start, end };
    })
    .filter(
      (selection): selection is Pick<LineSelection, "start" | "end"> =>
        selection !== null,
    );
  const errorMessage =
    typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : undefined;
  const selectionBounds = inrelavate ? [] : parsedSelectionBounds;
  const selections = buildSelectionsFromBounds(lines, selectionBounds);
  console.log("[subagent.extract.agent.parsed]", {
    query: clampText(query, 160),
    viewpoint: clampText(viewpoint, 120),
    broken,
    inrelavate,
    error: errorMessage ? clampText(errorMessage, 240) : undefined,
    selections: selections.length,
    selectionSummary: summarizeSelections(selections),
    selectionsPreview: summarizeContentsPreview(
      selections.map((selection) => selection.text),
    ),
    rawModelOutputPreview: clampText(result.text, 220),
  });
  return {
    viewpoint,
    selections,
    broken,
    inrelavate,
    error: errorMessage,
    rawModelOutput: result.text,
  };
}
