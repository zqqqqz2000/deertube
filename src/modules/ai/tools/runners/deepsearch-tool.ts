import {
  streamText,
  type LanguageModel,
  type UIMessageStreamWriter,
} from "ai";
import type {
  DeepResearchPersistenceAdapter,
  DeepResearchReferenceRecord,
} from "../../../../shared/deepresearch";
import { DEEPSEARCH_SYSTEM } from "../schemas";
import {
  buildDeepSearchContext,
  buildDeepSearchReferences,
  buildDeepSearchSources,
  linkifyCitationMarkers,
  writeDeepSearchStream,
} from "../helpers";
import type { DeepSearchReference, DeepSearchSource } from "../types";
import { runSearchSubagent } from "./search-subagent";

export async function runDeepSearchTool({
  query,
  model,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
  deepResearchStore,
}: {
  query: string;
  model: LanguageModel;
  writer?: UIMessageStreamWriter;
  toolCallId?: string;
  toolName?: string;
  abortSignal?: AbortSignal;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
}): Promise<{
  conclusion: string;
  sources: DeepSearchSource[];
  references: DeepSearchReference[];
  searchId: string;
  projectId?: string;
  prompt: string;
}> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    const message = "Query is empty after trimming.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
    );
    throw new Error(message);
  }
  const fallbackCreatedAt = new Date().toISOString();
  const searchSession = deepResearchStore
    ? await deepResearchStore.createSearchSession(normalizedQuery)
    : { searchId: `local-${Date.now()}`, createdAt: fallbackCreatedAt };
  const searchId = searchSession.searchId;
  const searchCreatedAt = searchSession.createdAt ?? fallbackCreatedAt;
  const projectId = deepResearchStore?.projectId;
  writeDeepSearchStream(writer, toolCallId, toolName, {
    query: normalizedQuery,
    projectId,
    searchId,
    status: "running",
  });

  try {
    const results = await runSearchSubagent({
      query: normalizedQuery,
      searchId,
      model,
      writer,
      toolCallId,
      toolName: "search",
      abortSignal,
      tavilyApiKey,
      jinaReaderBaseUrl,
      jinaReaderApiKey,
      deepResearchStore,
    });
    const references = buildDeepSearchReferences(results, projectId, searchId);
    const sources = buildDeepSearchSources(results, references);
    writeDeepSearchStream(writer, toolCallId, toolName, {
      query: normalizedQuery,
      projectId,
      searchId,
      sources,
      references,
      status: "running",
    });

    let prompt = "";
    let conclusionRaw = "";
    const sourceErrors = Array.from(
      new Set(
        results
          .map((item) =>
            typeof item.error === "string" ? item.error.trim() : "",
          )
          .filter((error) => error.length > 0),
      ),
    );
    if (sources.length === 0 || references.length === 0) {
      const errorDetails =
        sourceErrors.length > 0
          ? [
              "",
              "Observed tool errors:",
              ...sourceErrors.map((error, index) => `${index + 1}. ${error}`),
              "Explain these failures in user language and suggest practical next steps.",
            ].join("\n")
          : "";
      prompt = [
        `Question: ${normalizedQuery}`,
        "",
        "No validated references are currently available.",
        "Explain the current evidence status and what additional search directions would help.",
        errorDetails,
      ].join("\n");
    } else {
      prompt = buildDeepSearchContext(normalizedQuery, references);
    }
    const result = streamText({
      model,
      system: DEEPSEARCH_SYSTEM,
      prompt,
      abortSignal,
    });
    for await (const delta of result.textStream) {
      conclusionRaw += delta;
      writeDeepSearchStream(writer, toolCallId, toolName, {
        query: normalizedQuery,
        projectId,
        searchId,
        sources,
        references,
        prompt,
        conclusion: linkifyCitationMarkers(conclusionRaw, references),
        status: "running",
      });
    }

    const finalConclusionRaw =
      conclusionRaw.trim() || "No conclusion generated.";
    const finalConclusionLinked = linkifyCitationMarkers(
      finalConclusionRaw,
      references,
    );
    if (deepResearchStore) {
      const persistedReferences: DeepResearchReferenceRecord[] = references.map(
        (reference) => ({
          refId: reference.refId,
          uri: reference.uri,
          pageId: reference.pageId,
          url: reference.url,
          title: reference.title,
          startLine: reference.startLine,
          endLine: reference.endLine,
          text: reference.text,
        }),
      );
      await deepResearchStore.finalizeSearch({
        searchId,
        query: normalizedQuery,
        llmPrompt: prompt,
        llmConclusionRaw: finalConclusionRaw,
        llmConclusionLinked: finalConclusionLinked,
        references: persistedReferences,
        createdAt: searchCreatedAt,
        completedAt: new Date().toISOString(),
      });
    }
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        projectId,
        searchId,
        prompt,
        sources,
        references,
        conclusion: finalConclusionLinked,
        status: "complete",
        complete: true,
      },
      true,
    );

    return {
      conclusion: finalConclusionLinked,
      sources,
      references,
      searchId,
      projectId,
      prompt,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Deep search failed.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        projectId,
        searchId,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
    );
    throw error instanceof Error ? error : new Error(message);
  }
}
