import { z } from "zod";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  streamText,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";
import type { DeertubeUIMessage } from "../../../src/modules/ai/tools";
import { createTools } from "../../../src/modules/ai/tools";
import { createDeepResearchPersistenceAdapter } from "../../deepresearch/store";

const noStepLimit = () => false;

export const chatRouter = createTRPCRouter({
  send: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(z.custom<DeertubeUIMessage>()),
        context: z
          .object({
            selectedNodeSummary: z.string().optional(),
            selectedPathSummary: z.string().optional(),
          })
          .optional(),
        settings: z
          .object({
            llmProvider: z.string().optional(),
            llmModelId: z.string().optional(),
            llmApiKey: z.string().optional(),
            llmBaseUrl: z.string().optional(),
            tavilyApiKey: z.string().optional(),
            jinaReaderBaseUrl: z.string().optional(),
            jinaReaderApiKey: z.string().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const rawProvider = input.settings?.llmProvider?.trim();
      const llmProvider = rawProvider && rawProvider.length > 0 ? rawProvider : "openai";
      const llmModelId = input.settings?.llmModelId ?? "gpt-4o-mini";
      const providerApiKey = input.settings?.llmApiKey;
      const rawBaseUrl = input.settings?.llmBaseUrl?.trim();
      const providerBaseUrl =
        rawBaseUrl && rawBaseUrl.length > 0
          ? rawBaseUrl
          : (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1");

      const provider = createOpenAICompatible({
        name: llmProvider || "openai",
        baseURL: providerBaseUrl,
        apiKey: providerApiKey,
      });

      const contextLines: string[] = [];
      if (input.context?.selectedNodeSummary) {
        contextLines.push(input.context.selectedNodeSummary);
      }
      if (input.context?.selectedPathSummary) {
        contextLines.push(
          `Root-to-selected context:\n${input.context.selectedPathSummary}`,
        );
      }
      const systemPrompt = [
        "You are a concise assistant. Answer clearly and directly. When relevant, structure the response in short paragraphs.",
        "Always answer in the same language as the user's latest question.",
        "When a question requires external evidence or sources, call the `deepSearch` tool (it performs network search and uses a subagent for deep exploration).",
        "Before providing any citation link or any non-speculative factual claim, you must call the `deepSearch` tool and ground the claim in its references.",
        "If you used the `deepSearch` tool, keep citation markers like [1], [2] exactly as provided by the tool output and do not rewrite them into footnotes.",
        "Do not merge citations into one bracket like [1,2] or [1-2]; keep separate markers [1], [2].",
        "When citations are present, append a final `References` section at the end and list the corresponding source URLs in academic style, e.g. `[1] https://...`.",
        ...contextLines,
      ]
        .filter(Boolean)
        .join("\n\n");

      const model = provider(llmModelId);
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserText =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content.slice(0, 200)
          : "";
      console.log("[chat.send]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: llmProvider,
        model: llmModelId,
      });
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: await convertToModelMessages(input.messages, {
          ignoreIncompleteToolCalls: true,
        }),
      });

      return { text: result.text };
    }),
  stream: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(z.custom<DeertubeUIMessage>()),
        context: z
          .object({
            selectedNodeSummary: z.string().optional(),
            selectedPathSummary: z.string().optional(),
          })
          .optional(),
        settings: z
          .object({
            llmProvider: z.string().optional(),
            llmModelId: z.string().optional(),
            llmApiKey: z.string().optional(),
            llmBaseUrl: z.string().optional(),
            tavilyApiKey: z.string().optional(),
            jinaReaderBaseUrl: z.string().optional(),
            jinaReaderApiKey: z.string().optional(),
          })
          .optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const rawProvider = input.settings?.llmProvider?.trim();
      const llmProvider = rawProvider && rawProvider.length > 0 ? rawProvider : "openai";
      const llmModelId = input.settings?.llmModelId ?? "gpt-4o-mini";
      const providerApiKey = input.settings?.llmApiKey;
      const rawBaseUrl = input.settings?.llmBaseUrl?.trim();
      const providerBaseUrl =
        rawBaseUrl && rawBaseUrl.length > 0
          ? rawBaseUrl
          : (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1");

      const provider = createOpenAICompatible({
        name: llmProvider || "openai",
        baseURL: providerBaseUrl,
        apiKey: providerApiKey,
      });

      const contextLines: string[] = [];
      if (input.context?.selectedNodeSummary) {
        contextLines.push(input.context.selectedNodeSummary);
      }
      if (input.context?.selectedPathSummary) {
        contextLines.push(
          `Root-to-selected context:\n${input.context.selectedPathSummary}`,
        );
      }
      const systemPrompt = [
        "You are a concise assistant. Answer clearly and directly. When relevant, structure the response in short paragraphs.",
        "Always answer in the same language as the user's latest question.",
        "When a question requires external evidence or sources, call the `deepSearch` tool (it performs network search and uses a subagent for deep exploration).",
        "Before providing any citation link or any non-speculative factual claim, you must call the `deepSearch` tool and ground the claim in its references.",
        "If you used the `deepSearch` tool, keep citation markers like [1], [2] exactly as provided by the tool output and do not rewrite them into footnotes.",
        "Do not merge citations into one bracket like [1,2] or [1-2]; keep separate markers [1], [2].",
        "When citations are present, append a final `References` section at the end and list the corresponding source URLs in academic style, e.g. `[1] https://...`.",
        ...contextLines,
      ]
        .filter(Boolean)
        .join("\n\n");

      const model = provider(llmModelId);
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserText =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content.slice(0, 200)
          : "";
      console.log("[chat.stream]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: llmProvider,
        model: llmModelId,
      });
      const stream = createUIMessageStream<DeertubeUIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const deepResearchStore = createDeepResearchPersistenceAdapter(input.projectPath);
          const tools = createTools(writer, {
            model,
            tavilyApiKey: input.settings?.tavilyApiKey,
            jinaReaderBaseUrl: input.settings?.jinaReaderBaseUrl,
            jinaReaderApiKey: input.settings?.jinaReaderApiKey,
            deepResearchStore,
          });
          const result = streamText({
            model,
            system: systemPrompt,
            messages: await convertToModelMessages(input.messages, {
              ignoreIncompleteToolCalls: true,
            }),
            tools,
            toolChoice: "auto",
            stopWhen: noStepLimit,
            abortSignal: signal,
          });
          writer.merge(result.toUIMessageStream());
        },
      });

      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        yield value;
      }
    }),
});

export type ChatRouter = typeof chatRouter;
