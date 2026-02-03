import type { UseChatOptions } from "@ai-sdk/react";
import { useChat as useChatSDK } from "@ai-sdk/react";
import { useEffect, useRef } from "react";
import { ChatContext, ElectronChatTransport } from "./electron-chat-transport";
import type { DeertubeUIMessage } from "@/modules/ai/tools";

type ElectronChatOptions<TMessage extends DeertubeUIMessage = DeertubeUIMessage> =
  UseChatOptions<TMessage> & {
    context?: ChatContext;
  };

export function useChat<TMessage extends DeertubeUIMessage = DeertubeUIMessage>(
  options?: ElectronChatOptions<TMessage>,
) {
  const transportRef = useRef<ElectronChatTransport | null>(null);

  if (!transportRef.current) {
    transportRef.current = new ElectronChatTransport();
  }

  useEffect(() => {
    if (options?.context) {
      transportRef.current?.updateContext(options.context);
    }
  }, [options?.context]);

  const { context: _context, ...restOptions } = options ?? {};

  return useChatSDK({
    transport: transportRef.current,
    ...restOptions,
  });
}
