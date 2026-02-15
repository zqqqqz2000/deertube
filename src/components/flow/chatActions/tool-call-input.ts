import type { ChatMessage, ToolCallEventInput } from "@/types/chat";
import { isJsonObject } from "@/types/json";

const isToolCallEventInput = (
  input: ChatMessage["toolInput"],
): input is ToolCallEventInput => {
  if (!input || !isJsonObject(input)) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.responseId === "string" &&
    typeof candidate.toolCallId === "string"
  );
};

export const readResponseId = (input: ChatMessage["toolInput"]): string | null => {
  if (isToolCallEventInput(input)) {
    return input.responseId;
  }
  if (!input || !isJsonObject(input)) {
    return null;
  }
  const responseId = input.responseId;
  return typeof responseId === "string" ? responseId : null;
};

export const readToolCallId = (input: ChatMessage["toolInput"]): string | null => {
  if (isToolCallEventInput(input)) {
    return input.toolCallId;
  }
  if (!input || !isJsonObject(input)) {
    return null;
  }
  const toolCallId = input.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : null;
};
