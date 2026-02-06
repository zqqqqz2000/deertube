import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";
import { forwardRef } from "react";
import { ScrollBar } from "@/components/ui/scroll-area";

type ChatMessagesProps = React.ComponentProps<"div"> & {
  contentRef?: React.Ref<HTMLDivElement>;
};

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(
  ({ children, className, contentRef, ...props }, ref) => (
    <ScrollAreaPrimitive.Root
      className={cn("relative flex-1 overflow-hidden", className)}
    >
      <ScrollAreaPrimitive.Viewport
        ref={ref}
        className="h-full w-full rounded-[inherit] [&>div]:!block [&>div]:min-w-full"
        {...props}
      >
        <div ref={contentRef} className="flex min-w-full flex-col gap-2 px-2 py-2">
          {children}
        </div>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);

ChatMessages.displayName = "ChatMessages";
