import { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";

export function createTools(_writer: UIMessageStreamWriter) {
  return {};
}

export type DeertubeUIDataTypes = Record<string, never>;

export type DeertubeUITools = InferUITools<ReturnType<typeof createTools>>;

export type DeertubeUIMessage = UIMessage<unknown, DeertubeUIDataTypes, DeertubeUITools>;
