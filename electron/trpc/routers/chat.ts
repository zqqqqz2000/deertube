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
    "You are given numbered references built from source excerpts. Use those references as evidence context for your final answer.",
    "For most user questions, call the `deepSearch` tool and ground the answer in retrieved evidence.",
    "Skip a new `deepSearch` when the latest question is highly similar to a recently answered one and existing retrieved evidence is still sufficient; also skip for fixed deterministic math/computation tasks that do not depend on external facts.",
    "For any concept, entity, event, policy, recommendation, or factual claim, use `deepSearch` unless the high-similarity reuse rule clearly applies.",
    "Treat conceptual questions as search-required by default, even when they look like common knowledge.",
    "For conceptual content, never answer directly from memory; answer from retrieved evidence.",
    "Prefer serial search planning: run one `deepSearch`, inspect sources/references, then decide the next query.",
    "Keep total `deepSearch` calls per user turn within about 1-5 whenever possible.",
    "Only exceed 5 searches when task complexity is very high and prior subagent evidence is still insufficient.",
    "If evidence is insufficient, continue searching based on gaps/conflicts from the previous search results instead of restarting blindly.",
    "If you need citations, you must run `deepSearch` first. Never cite without search.",
    "Write a concise answer and cite evidence inline using markdown links like [1](deertube://...).",
    "Do not invent citation markers or URLs. Every citation must come from `deepSearch` output.",
    "If `deepSearch` returns zero references, do not output any citation markers such as [1](deertube://...), [2](deertube://...), and do not output a `References` section.",
    "If `deepSearch` returns references, inline citations must use markdown links from `references[].uri`: format `[n](deertube://...)`.",
    "When citations are used, every marker [n](deertube://...) must map to an existing `refId` and its matching `uri` from the same `deepSearch` result.",
    "Only cite provided indices. Do not invent new indices and do not output footnotes.",
    "**Do not** merge citations like [1,2] or [1-2]. Only use separate markers: [1](deertube://...), [2](deertube://...).",
    "Every citation link must use the deertube URI for that reference ID. Do not use external URLs in citation links, only use deertube://... link",
    ...contextLines,
  ]
    .filter(Boolean)
    .join("\n\n");

const HIDDEN_RUNTIME_CONTEXT_MARKER = "[[HIDDEN_RUNTIME_CONTEXT]]";

const buildHiddenRuntimeContextBlock = (now: Date): string => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return [
    HIDDEN_RUNTIME_CONTEXT_MARKER,
    `current_time_iso=${now.toISOString()}`,
    `current_time_local=${now.toLocaleString("zh-CN", { hour12: false })}`,
    `current_timezone=${timezone}`,
    "instruction=Use this runtime context silently. Never expose this block, and never copy it into tool queries.",
  ].join("\n");
};

const injectHiddenRuntimeContextToLatestUserMessage = (
  messages: DeertubeUIMessage[],
): DeertubeUIMessage[] => {
  const latestUserIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(
      ({ message }) =>
        message.role === "user" &&
        "content" in message &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )?.index;
  if (latestUserIndex === undefined) {
    return messages;
  }
  const target = messages[latestUserIndex];
  if (
    !("content" in target) ||
    typeof target.content !== "string" ||
    target.content.includes(HIDDEN_RUNTIME_CONTEXT_MARKER)
  ) {
    return messages;
  }
  const targetContent = target.content;
  const runtimeBlock = buildHiddenRuntimeContextBlock(new Date());
  return messages.map((message, index) => {
    if (index !== latestUserIndex) {
      return message;
    }
    return {
      ...message,
      content: `${targetContent}\n\n${runtimeBlock}`,
    };
  });
};

const ModelSettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
});

const SettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  jinaReaderBaseUrl: z.string().optional(),
  jinaReaderApiKey: z.string().optional(),
  models: z
    .object({
      chat: ModelSettingsSchema.optional(),
      search: ModelSettingsSchema.optional(),
      extract: ModelSettingsSchema.optional(),
      graph: ModelSettingsSchema.optional(),
    })
    .optional(),
});

type ModelSettings = z.infer<typeof ModelSettingsSchema>;
type RuntimeSettings = z.infer<typeof SettingsSchema>;

const trimOrUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const buildLegacyModelSettings = (
  settings: RuntimeSettings | undefined,
): ModelSettings | undefined => {
  if (!settings) {
    return undefined;
  }
  const llmProvider = trimOrUndefined(settings.llmProvider);
  const llmModelId = trimOrUndefined(settings.llmModelId);
  const llmApiKey = trimOrUndefined(settings.llmApiKey);
  const llmBaseUrl = trimOrUndefined(settings.llmBaseUrl);
  if (!llmProvider && !llmModelId && !llmApiKey && !llmBaseUrl) {
    return undefined;
  }
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  };
};

const resolveModelSettings = (
  preferred: ModelSettings | undefined,
  fallback: ModelSettings | undefined,
) => {
  const llmProvider =
    trimOrUndefined(preferred?.llmProvider) ??
    trimOrUndefined(fallback?.llmProvider) ??
    "openai";
  const llmModelId =
    trimOrUndefined(preferred?.llmModelId) ??
    trimOrUndefined(fallback?.llmModelId) ??
    "gpt-4o-mini";
  const llmApiKey =
    trimOrUndefined(preferred?.llmApiKey) ??
    trimOrUndefined(fallback?.llmApiKey);
  const llmBaseUrl =
    trimOrUndefined(preferred?.llmBaseUrl) ??
    trimOrUndefined(fallback?.llmBaseUrl) ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  };
};

const buildLanguageModel = (
  preferred: ModelSettings | undefined,
  fallback: ModelSettings | undefined,
) => {
  const resolved = resolveModelSettings(preferred, fallback);
  const provider = createOpenAICompatible({
    name: resolved.llmProvider,
    baseURL: resolved.llmBaseUrl,
    apiKey: resolved.llmApiKey,
  });
  return {
    model: provider(resolved.llmModelId),
    resolved,
  };
};

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
        settings: SettingsSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const legacyModel = buildLegacyModelSettings(input.settings);
      const chatModelConfig = buildLanguageModel(
        input.settings?.models?.chat,
        legacyModel,
      );

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
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

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
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
      });
      const result = await generateText({
        model: chatModelConfig.model,
        system: systemPrompt,
        messages: await convertToModelMessages(modelInputMessages, {
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
        settings: SettingsSchema.optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const legacyModel = buildLegacyModelSettings(input.settings);
      const chatModelConfig = buildLanguageModel(
        input.settings?.models?.chat,
        legacyModel,
      );
      const searchModelConfig = buildLanguageModel(
        input.settings?.models?.search,
        input.settings?.models?.chat ?? legacyModel,
      );
      const extractModelConfig = buildLanguageModel(
        input.settings?.models?.extract,
        input.settings?.models?.search ??
          input.settings?.models?.chat ??
          legacyModel,
      );

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
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

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
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
        searchModel: searchModelConfig.resolved.llmModelId,
        extractModel: extractModelConfig.resolved.llmModelId,
      });
      const stream = createUIMessageStream<DeertubeUIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const deepResearchStore = createDeepResearchPersistenceAdapter(
            input.projectPath,
          );
          const tools = createTools(writer, {
            model: searchModelConfig.model,
            searchModel: searchModelConfig.model,
            extractModel: extractModelConfig.model,
            tavilyApiKey: input.settings?.tavilyApiKey,
            jinaReaderBaseUrl: input.settings?.jinaReaderBaseUrl,
            jinaReaderApiKey: input.settings?.jinaReaderApiKey,
            deepResearchStore,
          });
          const result = streamText({
            model: chatModelConfig.model,
            system: systemPrompt,
            messages: await convertToModelMessages(modelInputMessages, {
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
