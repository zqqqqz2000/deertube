import { cn } from "@/lib/utils";
import { forwardRef } from "react";

export const ChatMessages = forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ children, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-1 flex-col overflow-auto py-2", className)}
      {...props}
    >
      {children}
    </div>
  ),
);

ChatMessages.displayName = "ChatMessages";
