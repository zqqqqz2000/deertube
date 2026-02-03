import type { ReactNode } from "react";
import {
  ChatEvent,
  ChatEventAddon,
  ChatEventBody,
  ChatEventContent,
  ChatEventDescription,
} from "./chat-event";

export function AdditionalMessage({
  content,
  timestamp,
}: {
  content: ReactNode;
  timestamp: number;
}) {
  return (
    <ChatEvent className="group">
      <ChatEventAddon>
        <ChatEventDescription className="invisible text-right text-[8px] group-hover:visible @md/chat:text-[10px]">
          {new Intl.DateTimeFormat("en-US", {
            timeStyle: "short",
          }).format(timestamp)}
        </ChatEventDescription>
      </ChatEventAddon>
      <ChatEventBody>
        <ChatEventContent>{content}</ChatEventContent>
      </ChatEventBody>
    </ChatEvent>
  );
}
