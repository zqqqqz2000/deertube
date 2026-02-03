import { z } from "zod";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const chatRouter = createTRPCRouter({
  send: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(ChatMessageSchema),
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

      const result = await generateText({
        model: provider(llmModelId),
        system:
          "You are a concise assistant. Answer clearly and directly. When relevant, structure the response in short paragraphs.",
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      return { text: result.text };
    }),
});

export type ChatRouter = typeof chatRouter;
