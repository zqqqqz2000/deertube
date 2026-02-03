import { z } from "zod";
import { convertToModelMessages, createUIMessageStream, generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";
import type { DeertubeUIMessage } from "../../../src/modules/ai/tools";
import { createTools } from "../../../src/modules/ai/tools";

export const chatRouter = createTRPCRouter({
  send: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(z.custom<DeertubeUIMessage>()),
        context: z
          .object({
            selectedNodeSummary: z.string().optional(),
          })
          .optional(),
        settings: z
          .object({
            llmProvider: z.string().optional(),
            llmModelId: z.string().optional(),
            llmApiKey: z.string().optional(),
            llmBaseUrl: z.string().optional(),
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
      const systemPrompt = [
        "You are a concise assistant. Answer clearly and directly. When relevant, structure the response in short paragraphs.",
        ...contextLines,
      ]
        .filter(Boolean)
        .join("\n\n");

      const result = await generateText({
        model: provider(llmModelId),
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
          })
          .optional(),
        settings: z
          .object({
            llmProvider: z.string().optional(),
            llmModelId: z.string().optional(),
            llmApiKey: z.string().optional(),
            llmBaseUrl: z.string().optional(),
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
      const systemPrompt = [
        "You are a concise assistant. Answer clearly and directly. When relevant, structure the response in short paragraphs.",
        ...contextLines,
      ]
        .filter(Boolean)
        .join("\n\n");

      const stream = createUIMessageStream<DeertubeUIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const tools = createTools(writer);
          const result = streamText({
            model: provider(llmModelId),
            system: systemPrompt,
            messages: await convertToModelMessages(input.messages, {
              ignoreIncompleteToolCalls: true,
            }),
            tools,
            toolChoice: "auto",
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
