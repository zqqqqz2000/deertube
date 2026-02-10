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

const buildMainAgentSystemPrompt = (contextLines: string[]) =>
  [
    "You are a concise assistant. Answer clearly and directly. Use short paragraphs when helpful.",
    "Always answer in the same language as the user's latest question.",
    "Unless the user explicitly requests translation, keep the response language identical to the user's question language.",
    "For almost all user questions, call the `deepSearch` tool first and ground the answer in retrieved evidence.",
    "Only skip `deepSearch` for fixed deterministic math/computation tasks that do not depend on external facts.",
    "For any concept, entity, event, policy, recommendation, or factual claim, you must use `deepSearch` before answering.",
    "Do not answer from intuition or prior belief. If evidence is insufficient, say so explicitly and continue searching.",
    "If you need citations, you must run `deepSearch` first. Never cite without search.",
    "Do not invent citation markers or URLs. Every citation must come from `deepSearch` output.",
    "If `deepSearch` returns zero references, do not output any citation markers such as [1], [2], and do not output a `References` section.",
    "If `deepSearch` returns references, inline citations must use markdown links from `references[].uri`: format `[n](deertube://...)`.",
    "When citations are used, every marker [n](...) must map to an existing `refId` and its matching `uri` from the same `deepSearch` result.",
    "Do not merge citations like [1,2] or [1-2]. Use separate markers: [1](...), [2](...).",
    "Do not append a manual `References` section with raw URLs; rely on inline linked citations only.",
    ...contextLines,
  ]
    .filter(Boolean)
    .join("\n\n");

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
      const llmProvider =
        rawProvider && rawProvider.length > 0 ? rawProvider : "openai";
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
      const systemPrompt = buildMainAgentSystemPrompt(contextLines);

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
      const llmProvider =
        rawProvider && rawProvider.length > 0 ? rawProvider : "openai";
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
      const systemPrompt = buildMainAgentSystemPrompt(contextLines);

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
          const deepResearchStore = createDeepResearchPersistenceAdapter(
            input.projectPath,
          );
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
