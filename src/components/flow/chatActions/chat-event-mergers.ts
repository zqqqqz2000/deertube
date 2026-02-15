import type { ChatMessage } from "@/types/chat";
import { readResponseId } from "./tool-call-input";

const toMessageTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
};

const insertResidualEventsByCreatedAt = (
  baseMessages: ChatMessage[],
  residualEvents: ChatMessage[],
): ChatMessage[] => {
  if (residualEvents.length === 0) {
    return baseMessages;
  }
  const sortedResidualEvents = [...residualEvents].sort((left, right) => {
    const leftTimestamp = toMessageTimestamp(left.createdAt);
    const rightTimestamp = toMessageTimestamp(right.createdAt);
    return leftTimestamp - rightTimestamp;
  });
  const merged = [...baseMessages];
  sortedResidualEvents.forEach((event) => {
    const eventTimestamp = toMessageTimestamp(event.createdAt);
    const insertIndex = merged.findIndex(
      (message) => toMessageTimestamp(message.createdAt) > eventTimestamp,
    );
    if (insertIndex < 0) {
      merged.push(event);
      return;
    }
    merged.splice(insertIndex, 0, event);
  });
  return merged;
};

const mergeEventsByResponseId = ({
  messages,
  events,
  getResponseId,
}: {
  messages: ChatMessage[];
  events: ChatMessage[];
  getResponseId: (event: ChatMessage) => string | null;
}): ChatMessage[] => {
  if (events.length === 0) {
    return messages;
  }

  const byResponseId = new Map<string, ChatMessage[]>();
  const unattached: ChatMessage[] = [];

  events.forEach((event) => {
    const responseId = getResponseId(event);
    if (!responseId) {
      unattached.push(event);
      return;
    }
    const list = byResponseId.get(responseId) ?? [];
    list.push(event);
    byResponseId.set(responseId, list);
  });

  const merged: ChatMessage[] = [];
  messages.forEach((message) => {
    merged.push(message);
    const attached = byResponseId.get(message.id);
    if (!attached || attached.length === 0) {
      return;
    }
    merged.push(...attached);
    byResponseId.delete(message.id);
  });

  const residualEvents: ChatMessage[] = [...unattached];
  byResponseId.forEach((attached) => residualEvents.push(...attached));
  return insertResidualEventsByCreatedAt(merged, residualEvents);
};

const readTypedEventResponseId = (
  event: ChatMessage,
  kind: ChatMessage["kind"],
): string | null => {
  if (event.kind !== kind) {
    return null;
  }
  return readResponseId(event.toolInput);
};

export const mergeGraphEvents = (
  messages: ChatMessage[],
  graphEvents: ChatMessage[],
): ChatMessage[] =>
  mergeEventsByResponseId({
    messages,
    events: graphEvents,
    getResponseId: (event) => readTypedEventResponseId(event, "graph-event"),
  });

export const mergeSubagentEvents = (
  messages: ChatMessage[],
  subagentEvents: ChatMessage[],
): ChatMessage[] =>
  mergeEventsByResponseId({
    messages,
    events: subagentEvents,
    getResponseId: (event) => readTypedEventResponseId(event, "subagent-event"),
  });

export const mergeDeepSearchEvents = (
  messages: ChatMessage[],
  deepSearchEvents: ChatMessage[],
): ChatMessage[] =>
  mergeEventsByResponseId({
    messages,
    events: deepSearchEvents,
    getResponseId: (event) =>
      readTypedEventResponseId(event, "deepsearch-event"),
  });

export const mergePersistedAgentEvents = (
  persisted: ChatMessage[],
  runtime: ChatMessage[],
): ChatMessage[] => {
  if (persisted.length === 0) {
    return runtime;
  }
  if (runtime.length === 0) {
    return persisted;
  }
  const byId = new Map<string, ChatMessage>();
  persisted.forEach((message) => {
    byId.set(message.id, message);
  });
  runtime.forEach((message) => {
    byId.set(message.id, message);
  });
  return Array.from(byId.values());
};
