import { InferUITools, UIMessage, type UIMessageStreamWriter, tool } from "ai";
import { z } from "zod";
import { runDeepSearchTool } from "./tools/runner";
import type {
  DeepSearchReference,
  DeepSearchSource,
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  ToolConfig,
} from "./tools/types";

export type {
  DeepSearchReference,
  DeepSearchSource,
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  ToolConfig,
};

export type DeertubeUITools = InferUITools<ReturnType<typeof createTools>>;

export type DeertubeUIMessage = UIMessage<
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  DeertubeUITools
>;

export function createTools(
  writer: UIMessageStreamWriter,
  config: ToolConfig = {},
) {
  return {
    deepSearch: tool({
      description:
        "Run deep research via network search and a subagent, returning structured references for citation. For citations, use references[].uri as inline markdown links like [1](deertube://...).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("User research question to answer with cited evidence."),
      }).describe("Input payload for the deepSearch tool."),
      outputSchema: z.object({
        conclusion: z
          .string()
          .optional()
          .describe("Optional synthesized answer text (disabled by default)."),
        answer: z
          .string()
          .optional()
          .describe("Optional alias of conclusion for compatibility."),
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
            viewpoint: z
              .string()
              .describe("Viewpoint this reference supports."),
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
          .optional()
          .describe("Optional synthesis prompt (empty when synthesis is disabled)."),
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
          references: result.references,
          searchId: result.searchId,
          projectId: result.projectId,
          prompt: result.prompt,
        };
      },
    }),
  };
}
