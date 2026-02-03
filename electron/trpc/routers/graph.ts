import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";

const GraphNodeSchema = z.object({
  titleLong: z.string().min(1),
  titleShort: z.string().min(1),
  titleTiny: z.string().min(1),
  excerpt: z.string().min(1),
  parentIntId: z.number().int(),
});

const clampText = (input: string, maxChars: number) => {
  const chars = Array.from(input.trim());
  if (chars.length <= maxChars) {
    return input.trim();
  }
  return chars.slice(0, maxChars).join("");
};

const ensureExcerpt = (excerpt: string, source: string) => {
  const cleaned = excerpt.trim();
  if (cleaned && source.includes(cleaned)) {
    return cleaned;
  }
  return clampText(source, 120) || cleaned;
};

export const graphRouter = createTRPCRouter({
  run: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        responseId: z.string(),
        responseText: z.string(),
        selectedNodeId: z.string().optional(),
        selectedNodeSummary: z.string().optional(),
        graph: z.object({
          nodes: z.array(
            z.object({
              intId: z.number().int(),
              type: z.string(),
              label: z.string().optional(),
              excerpt: z.string().optional(),
            }),
          ),
          edges: z.array(
            z.object({
              sourceIntId: z.number().int(),
              targetIntId: z.number().int(),
            }),
          ),
        }),
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

      const actions: {
        id: string;
        titleLong: string;
        titleShort: string;
        titleTiny: string;
        excerpt: string;
        parentIntId: number;
        responseId: string;
      }[] = [];

      const addInsightNodeTool = tool({
        description:
          "Add a single graph insight node linked to the response. Excerpt must be an exact quote from the response.",
        inputSchema: GraphNodeSchema,
        execute: (data) => {
          const excerpt = ensureExcerpt(data.excerpt, input.responseText);
          actions.push({
            id: randomUUID(),
            titleLong: clampText(data.titleLong, 30),
            titleShort: clampText(data.titleShort, 10),
            titleTiny: clampText(data.titleTiny, 6),
            excerpt,
            parentIntId: data.parentIntId,
            responseId: input.responseId,
          });
          return { ok: true };
        },
      });

      const contextBlock = input.selectedNodeSummary
        ? `Selected node context:\n${input.selectedNodeSummary}\n\n`
        : "";

      const graphLines = [
        "Graph nodes (intId -> type | label | excerpt):",
        ...input.graph.nodes.map((node) => {
          const parts = [
            `${node.intId}`,
            node.type,
            node.label ? `"${node.label}"` : "",
            node.excerpt ? `"${node.excerpt}"` : "",
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        }),
        "Graph edges (sourceIntId -> targetIntId):",
        ...input.graph.edges.map((edge) => `- ${edge.sourceIntId} -> ${edge.targetIntId}`),
      ]
        .filter(Boolean)
        .join("\n");

      await generateText({
        model: provider(llmModelId),
        system:
          "You are a graph-builder for a product that builds a clear, easy-to-understand knowledge map during conversation. Only call addInsightNodeTool when the response introduces new, distillable information worth adding to the graph; otherwise, do not call any tools. If you do call the tool, create 1-3 concise insight nodes derived from the response. When there would be many new nodes, you may aggregate them into fewer, higher-level nodes. Each node must quote an exact excerpt from the response text. Titles must be short, clear, and in three sizes: long (<=30 chars), short (<=10 chars), tiny (<=6 chars). You MUST provide parentIntId for every node. Do not add explanations outside tool calls.",
        prompt: `${contextBlock}${graphLines}\n\nResponse:\n${input.responseText}\n\nCreate nodes now.`,
        tools: { addInsightNodeTool },
        stopWhen: stepCountIs(4),
      });

      return {
        nodes: actions.map((action) => ({
          ...action,
        })),
      };
    }),
});

export type GraphRouter = typeof graphRouter;
