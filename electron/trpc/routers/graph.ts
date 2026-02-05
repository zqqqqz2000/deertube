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
  throw new Error("Excerpt must be an exact quote from the response.");
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
            titleShort: clampText(data.titleShort, 16),
            titleTiny: clampText(data.titleTiny, 18),
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

      const result = await generateText({
        model: provider(llmModelId),
        system:
          "You are a graph-builder for a product that builds a clear, easy-to-understand knowledge map during conversation. Only call addInsightNodeTool when the response introduces new, distillable information worth adding to the graph; otherwise, respond with a short explanation of why no node should be added. When there would be many new nodes, you may aggregate them into fewer, higher-level nodes. If the response contains multiple derivative points, you may create nodes at multiple levels of the graph and are not limited to the currently selected node. Each node must quote an exact excerpt from the response text. Excerpts must be a verbatim span from the response; if you add multiple nodes, avoid repeating or overlapping excerpts. Titles must be short, clear, and in three sizes: long (<=48 chars), short (<=28 chars), tiny (<=20 chars). Long/Short/Tiny should become progressively shorter and more abstract. Use the same language as the response for all titles. The language of all three titles must match the response. You MUST provide parentIntId for every node.",
        prompt: `${contextBlock}${graphLines}\n\nResponse:\n${input.responseText}\n\nCreate nodes now.`,
        tools: { addInsightNodeTool },
        stopWhen: stepCountIs(4),
      });

      return {
        nodes: actions.map((action) => ({
          ...action,
        })),
        explanation:
          actions.length === 0 && result.text.trim().length > 0
            ? result.text.trim()
            : undefined,
      };
    }),
});

export type GraphRouter = typeof graphRouter;
