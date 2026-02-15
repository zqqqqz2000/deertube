import type { ChatMessage } from "@/types/chat";
import type {
  DeertubeMessageMetadata,
  DeertubeUIMessage,
} from "@/modules/ai/tools";
import { extractUiMessageText } from "./message-part-parsers";

export const mapChatToUiMessage = (message: ChatMessage): DeertubeUIMessage => {
  const metadata =
    (message.status ?? message.error)
      ? {
          status: message.status,
          error: message.error,
        }
      : undefined;
  return {
    id: message.id,
    role: message.role,
    metadata,
    parts: message.content
      ? [
          {
            type: "text",
            text: message.content,
          },
        ]
      : [],
  };
};

const extractMessageMetadata = (
  metadata: DeertubeMessageMetadata | null | undefined,
): { status?: ChatMessage["status"]; error?: string } => {
  if (!metadata) {
    return {};
  }
  const status =
    metadata.status === "pending" ||
    metadata.status === "complete" ||
    metadata.status === "failed"
      ? metadata.status
      : undefined;
  const error = typeof metadata.error === "string" ? metadata.error : undefined;
  return { status, error };
};

const resolveCreatedAt = (
  message: DeertubeUIMessage,
  fallbackCreatedAtById: Map<string, string>,
): string => {
  if ("createdAt" in message && message.createdAt) {
    return message.createdAt instanceof Date
      ? message.createdAt.toISOString()
      : String(message.createdAt);
  }
  const existing = fallbackCreatedAtById.get(message.id);
  if (existing) {
    return existing;
  }
  const next = new Date().toISOString();
  fallbackCreatedAtById.set(message.id, next);
  return next;
};

const applyTerminalStatus = (
  mapped: ChatMessage[],
  status: string,
  error: Error | undefined,
) => {
  const lastAssistant = [...mapped]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!lastAssistant) {
    return;
  }

  if (status === "streaming" || status === "submitted") {
    lastAssistant.status = "pending";
    lastAssistant.error = undefined;
    return;
  }
  if (status === "error") {
    lastAssistant.status = "failed";
    lastAssistant.error = error?.message ?? "Request failed";
    return;
  }
  if (!lastAssistant.status) {
    lastAssistant.status = "complete";
  }
};

export const mapUiMessagesToChat = (
  messages: DeertubeUIMessage[],
  status: string,
  error: Error | undefined,
  fallbackCreatedAtById: Map<string, string>,
): ChatMessage[] => {
  const activeMessageIds = new Set(messages.map((message) => message.id));
  Array.from(fallbackCreatedAtById.keys()).forEach((messageId) => {
    if (!activeMessageIds.has(messageId)) {
      fallbackCreatedAtById.delete(messageId);
    }
  });

  const mapped: ChatMessage[] = messages.map((message) => {
    const { status: persistedStatus, error: persistedError } =
      extractMessageMetadata(message.metadata);
    return {
      id: message.id,
      role: message.role as ChatMessage["role"],
      content: extractUiMessageText(message),
      createdAt: resolveCreatedAt(message, fallbackCreatedAtById),
      status: persistedStatus,
      error: persistedError,
    };
  });

  applyTerminalStatus(mapped, status, error);
  return mapped;
};
