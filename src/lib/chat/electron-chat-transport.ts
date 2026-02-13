import type { ChatRequestOptions, ChatTransport, UIMessageChunk } from "ai";
import { trpcClient } from "@/lib/trpc";
import type { LlmRuntimeModelSettings, LlmPurpose } from "@/lib/settings";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import type { DeepResearchConfigInput } from "@/shared/deepresearch-config";

export interface ChatContext {
  projectPath: string;
  selectedNodeSummary?: string;
  selectedPathSummary?: string;
  deepResearch?: DeepResearchConfigInput;
  settings?: {
    llmProvider?: string;
    llmModelId?: string;
    llmApiKey?: string;
    llmBaseUrl?: string;
    tavilyApiKey?: string;
    jinaReaderBaseUrl?: string;
    jinaReaderApiKey?: string;
    models?: Partial<Record<LlmPurpose, LlmRuntimeModelSettings>>;
  };
}

export class ElectronChatTransport implements ChatTransport<DeertubeUIMessage> {
  private context: ChatContext | null = null;

  updateContext(context: ChatContext) {
    this.context = context;
  }

  sendMessages(
    options: {
      chatId: string;
      messages: DeertubeUIMessage[];
      abortSignal: AbortSignal | undefined;
    } & {
      trigger: "submit-message" | "regenerate-message";
      messageId: string | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const context = this.context;

    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          const subscription = trpcClient.chat.stream.subscribe(
            {
              projectPath: context?.projectPath ?? "",
              messages: options.messages,
              settings: context?.settings,
              deepResearch: context?.deepResearch,
              context: {
                selectedNodeSummary: context?.selectedNodeSummary,
                selectedPathSummary: context?.selectedPathSummary,
              },
            },
            {
              onData: (chunk) => {
                controller.enqueue(chunk);
              },
              onError: (error) => {
                controller.error(error);
              },
              onComplete: () => {
                controller.close();
              },
            },
          );

          if (options.abortSignal) {
            options.abortSignal.addEventListener("abort", () => {
              subscription.unsubscribe();
              controller.close();
            });
          }
        },
      }),
    );
  }

  reconnectToStream(
    _options: {
      chatId: string;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}
