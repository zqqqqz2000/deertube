import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";
import { forwardRef } from "react";
import { ScrollBar } from "@/components/ui/scroll-area";

export const ChatMessages = forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ children, className, ...props }, ref) => (
    <ScrollAreaPrimitive.Root className={cn("flex-1 overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport
        ref={ref}
        className="h-full w-full rounded-[inherit]"
        {...props}
      >
        <div className="flex flex-col gap-2 py-2">{children}</div>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);

ChatMessages.displayName = "ChatMessages";
