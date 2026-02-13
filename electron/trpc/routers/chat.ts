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
import {
  buildMainAgentSystemPrompt,
  DeepResearchConfigSchema,
  resolveDeepResearchConfig,
} from "../../../src/shared/deepresearch-config";
import { scanLocalAgentSkills } from "../../skills/registry";
import type { RuntimeAgentSkill } from "../../../src/shared/agent-skills";

const noStepLimit = () => false;

const loadExternalSkills = async (): Promise<RuntimeAgentSkill[]> => {
  const scanResult = await scanLocalAgentSkills();
  return scanResult.skills.map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    activationHints: skill.activationHints,
    content: skill.content,
    source: skill.source,
    isSearchSkill: skill.isSearchSkill,
  }));
};

const filterExternalSkillsBySelection = (
  skills: RuntimeAgentSkill[],
  selectedSkillNames: string[],
): RuntimeAgentSkill[] => {
  const normalizedSelectedSkillNames = new Set(
    selectedSkillNames
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  if (normalizedSelectedSkillNames.size === 0) {
    return skills;
  }
  return skills.filter((skill) => {
    if (!skill.isSearchSkill) {
      return true;
    }
    return normalizedSelectedSkillNames.has(skill.name.trim().toLowerCase());
  });
};

const waitForAbort = (signal: AbortSignal): Promise<{ kind: "abort" }> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "abort" });
      return;
    }
    const handleAbort = () => {
      signal.removeEventListener("abort", handleAbort);
      resolve({ kind: "abort" });
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

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
        deepResearch: DeepResearchConfigSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const deepResearchConfig = resolveDeepResearchConfig(input.deepResearch);
      const externalSkills = filterExternalSkillsBySelection(
        await loadExternalSkills(),
        deepResearchConfig.selectedSkillNames,
      );
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
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserContent =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content
          : "";
      const systemPrompt = buildMainAgentSystemPrompt(
        contextLines,
        deepResearchConfig,
        { query: lastUserContent, availableSkills: externalSkills },
      );
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

      const lastUserText = lastUserContent.slice(0, 200);
      console.log("[chat.send]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
        deepResearchEnabled: deepResearchConfig.enabled,
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
        deepResearch: DeepResearchConfigSchema.optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const deepResearchConfig = resolveDeepResearchConfig(input.deepResearch);
      const externalSkills = filterExternalSkillsBySelection(
        await loadExternalSkills(),
        deepResearchConfig.selectedSkillNames,
      );
      const legacyModel = buildLegacyModelSettings(input.settings);
      const chatModelConfig = buildLanguageModel(
        input.settings?.models?.chat,
        legacyModel,
      );
      const searchModelConfig = deepResearchConfig.enabled
        ? buildLanguageModel(
            input.settings?.models?.search,
            input.settings?.models?.chat ?? legacyModel,
          )
        : null;
      const extractModelConfig = deepResearchConfig.enabled
        ? buildLanguageModel(
            input.settings?.models?.extract,
            input.settings?.models?.search ??
              input.settings?.models?.chat ??
              legacyModel,
          )
        : null;

      const contextLines: string[] = [];
      if (input.context?.selectedNodeSummary) {
        contextLines.push(input.context.selectedNodeSummary);
      }
      if (input.context?.selectedPathSummary) {
        contextLines.push(
          `Root-to-selected context:\n${input.context.selectedPathSummary}`,
        );
      }
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserContent =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content
          : "";
      const systemPrompt = buildMainAgentSystemPrompt(
        contextLines,
        deepResearchConfig,
        { query: lastUserContent, availableSkills: externalSkills },
      );
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

      const lastUserText = lastUserContent.slice(0, 200);
      console.log("[chat.stream]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
        searchModel: searchModelConfig?.resolved.llmModelId,
        extractModel: extractModelConfig?.resolved.llmModelId,
        deepResearchEnabled: deepResearchConfig.enabled,
      });
      const stream = createUIMessageStream<DeertubeUIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const modelMessages = await convertToModelMessages(modelInputMessages, {
            ignoreIncompleteToolCalls: true,
          });
          if (!deepResearchConfig.enabled) {
            const result = streamText({
              model: chatModelConfig.model,
              system: systemPrompt,
              messages: modelMessages,
              abortSignal: signal,
            });
            writer.merge(result.toUIMessageStream());
            return;
          }
          const deepResearchStore = createDeepResearchPersistenceAdapter(
            input.projectPath,
          );
          const tools = createTools(writer, {
            model: searchModelConfig?.model,
            searchModel: searchModelConfig?.model,
            extractModel: extractModelConfig?.model,
            tavilyApiKey: input.settings?.tavilyApiKey,
            jinaReaderBaseUrl: input.settings?.jinaReaderBaseUrl,
            jinaReaderApiKey: input.settings?.jinaReaderApiKey,
            deepResearchStore,
            deepResearchConfig,
            externalSkills,
          });
          const result = streamText({
            model: chatModelConfig.model,
            system: systemPrompt,
            messages: modelMessages,
            tools,
            toolChoice: "auto",
            stopWhen: noStepLimit,
            abortSignal: signal,
          });
          writer.merge(result.toUIMessageStream());
        },
      });

      const reader = stream.getReader();
      const abortPromise = signal ? waitForAbort(signal) : null;

      try {
        while (true) {
          const next = abortPromise
            ? await Promise.race([
                reader
                  .read()
                  .then((result) => ({ kind: "chunk" as const, result })),
                abortPromise,
              ])
            : {
                kind: "chunk" as const,
                result: await reader.read(),
              };
          if (next.kind === "abort") {
            await reader.cancel("chat stream aborted");
            break;
          }
          const { done, value } = next.result;
          if (done) {
            break;
          }
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }),
});

export type ChatRouter = typeof chatRouter;
