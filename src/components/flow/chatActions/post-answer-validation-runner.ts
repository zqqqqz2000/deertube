import {
  finishRunningChatJob,
  startRunningChatJob,
} from "@/lib/running-chat-jobs";
import type { RuntimeSettingsPayload } from "@/lib/settings";
import type {
  ChatMessage,
  DeepSearchReferencePayload,
  DeepSearchSourcePayload,
  DeepSearchStreamPayload,
} from "@/types/chat";
import type { DeepResearchConfig } from "@/shared/deepresearch-config";

interface ValidateMutationResult {
  status: "complete" | "failed" | "skipped";
  query?: string;
  projectId?: string;
  searchId?: string;
  sources?: DeepSearchSourcePayload[];
  references?: DeepSearchReferencePayload[];
}

interface RunPostAnswerValidationForResponseOptions {
  responseId: string;
  responseText: string;
  chatId: string | null;
  projectPath: string;
  deepResearchConfig: DeepResearchConfig;
  runtimeSettings: RuntimeSettingsPayload | undefined;
  queryOverride: string;
  isMounted: () => boolean;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
  runValidateMutation: (input: {
    projectPath: string;
    query: string;
    answer: string;
    settings: RuntimeSettingsPayload | undefined;
    deepResearch: DeepResearchConfig;
  }) => Promise<ValidateMutationResult>;
}

const setValidationEventRunning = ({
  responseId,
  eventId,
  toolCallId,
  query,
  setAsyncDeepSearchEventMessages,
}: {
  responseId: string;
  eventId: string;
  toolCallId: string;
  query: string;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const startedAt = new Date().toISOString();
  setAsyncDeepSearchEventMessages((prev) => [
    ...prev,
    {
      id: eventId,
      role: "assistant",
      content: "",
      createdAt: startedAt,
      kind: "deepsearch-event",
      toolName: "validate.run",
      toolStatus: "running",
      toolInput: {
        responseId,
        toolCallId,
      },
      toolOutput: {
        toolCallId,
        toolName: "validate.run",
        mode: "validate",
        query,
        status: "running",
      } satisfies DeepSearchStreamPayload,
    },
  ]);
};

const setValidationEventResolved = ({
  eventId,
  toolCallId,
  result,
  setAsyncDeepSearchEventMessages,
}: {
  eventId: string;
  toolCallId: string;
  result: ValidateMutationResult;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const skipped = result.status === "skipped";
  const status = result.status === "complete" ? "complete" : "failed";
  const skippedError = skipped ? "Validation skipped by config." : undefined;

  setAsyncDeepSearchEventMessages((prev) =>
    prev.map((event) =>
      event.id !== eventId
        ? event
        : {
            ...event,
            toolStatus: status,
            toolOutput: {
              toolCallId,
              toolName: "validate.run",
              mode: "validate",
              query: result.query,
              projectId: result.projectId,
              searchId: result.searchId,
              status,
              sources: result.sources,
              references: result.references,
              error: skippedError,
              complete: true,
            } satisfies DeepSearchStreamPayload,
            error: skippedError,
          },
    ),
  );
};

const setValidationEventFailed = ({
  eventId,
  toolCallId,
  query,
  errorMessage,
  setAsyncDeepSearchEventMessages,
}: {
  eventId: string;
  toolCallId: string;
  query: string;
  errorMessage: string;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  setAsyncDeepSearchEventMessages((prev) =>
    prev.map((event) =>
      event.id !== eventId
        ? event
        : {
            ...event,
            toolStatus: "failed",
            error: errorMessage,
            toolOutput: {
              toolCallId,
              toolName: "validate.run",
              mode: "validate",
              query,
              status: "failed",
              error: errorMessage,
              complete: true,
            } satisfies DeepSearchStreamPayload,
          },
    ),
  );
};

export const runPostAnswerValidationForResponse = async ({
  responseId,
  responseText,
  chatId,
  projectPath,
  deepResearchConfig,
  runtimeSettings,
  queryOverride,
  isMounted,
  setAsyncDeepSearchEventMessages,
  runValidateMutation,
}: RunPostAnswerValidationForResponseOptions): Promise<void> => {
  if (!deepResearchConfig.enabled || !deepResearchConfig.validate.enabled) {
    return;
  }

  const query = queryOverride.trim() || responseText.trim();
  if (!query) {
    return;
  }

  const toolCallId = `validate-${crypto.randomUUID()}`;
  const eventId = `deepsearch-${toolCallId}`;
  const runningJobId = `validate:${toolCallId}`;

  if (chatId) {
    startRunningChatJob(projectPath, chatId, runningJobId);
  }
  setValidationEventRunning({
    responseId,
    eventId,
    toolCallId,
    query,
    setAsyncDeepSearchEventMessages,
  });

  try {
    const result = await runValidateMutation({
      projectPath,
      query,
      answer: responseText,
      settings: runtimeSettings,
      deepResearch: deepResearchConfig,
    });
    if (!isMounted()) {
      return;
    }
    setValidationEventResolved({
      eventId,
      toolCallId,
      result,
      setAsyncDeepSearchEventMessages,
    });
  } catch (error) {
    if (!isMounted()) {
      return;
    }
    const errorMessage =
      error instanceof Error ? error.message : "Post-answer validation failed";
    setValidationEventFailed({
      eventId,
      toolCallId,
      query,
      errorMessage,
      setAsyncDeepSearchEventMessages,
    });
  } finally {
    if (chatId) {
      finishRunningChatJob(projectPath, chatId, runningJobId);
    }
  }
};
