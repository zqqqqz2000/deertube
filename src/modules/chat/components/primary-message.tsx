import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  ChatEvent,
  ChatEventAddon,
  ChatEventBody,
  ChatEventContent,
  ChatEventDescription,
  ChatEventTitle,
} from "./chat-event";

export function PrimaryMessage({
  avatarSrc,
  avatarAlt,
  avatarFallback,
  senderName,
  content,
  timestamp,
  className,
}: {
  avatarSrc?: string;
  avatarAlt?: string;
  avatarFallback?: string;
  senderName: string;
  content: ReactNode;
  timestamp: number;
  className?: string;
}) {
  return (
    <ChatEvent className={cn("group hover:bg-accent py-2", className)}>
      <ChatEventAddon>
        <Avatar className="mx-auto size-8 rounded-full @md/chat:size-10">
          <AvatarImage src={avatarSrc} alt={avatarAlt} />
          <AvatarFallback>{avatarFallback}</AvatarFallback>
        </Avatar>
      </ChatEventAddon>
      <ChatEventBody>
        <div className="flex items-baseline gap-2 mb-2">
          <ChatEventTitle>{senderName}</ChatEventTitle>
          <ChatEventDescription>
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(timestamp)}
          </ChatEventDescription>
        </div>
        <ChatEventContent>{content}</ChatEventContent>
      </ChatEventBody>
    </ChatEvent>
  );
}
