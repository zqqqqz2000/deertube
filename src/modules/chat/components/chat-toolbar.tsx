import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

export function ChatToolbar({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("sticky bottom-0 bg-background p-2 pt-0", className)} {...props}>
      <div
        className={cn(
          "grid grid-cols-[max-content_auto_max-content] gap-x-2 rounded-md border px-3 py-2"
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ChatToolbarAddonStart({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("row-start-1 col-start-1 flex h-10 items-center gap-1.5", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function ChatToolbarTextarea({
  className,
  ...props
}: React.ComponentProps<typeof Textarea>) {
  return (
    <div className="row-span-2 grid flex-1">
      <Textarea
        id="toolbar-input"
        placeholder="Type your message..."
        className={cn(
          "h-fit min-h-10 max-h-30 px-1 @md/chat:text-base",
          "resize-none border-none shadow-none placeholder:whitespace-nowrap focus-visible:border-none focus-visible:ring-0",
          className
        )}
        rows={1}
        {...props}
      />
    </div>
  );
}

export function ChatToolbarAddonEnd({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "row-start-1 col-start-3 flex h-10 items-center gap-1 @md/chat:gap-1.5",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
