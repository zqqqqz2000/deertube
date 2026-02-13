import { useRef } from "react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

export function ChatToolbar({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("sticky bottom-0 bg-background p-2 pt-0", className)}
      {...props}
    >
      <div
        className={cn(
          "grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_max-content] gap-x-2 gap-y-1 rounded-md border px-3 py-2",
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
      className={cn(
        "row-start-1 col-start-1 flex h-10 min-w-0 items-center gap-1.5 overflow-hidden",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ChatToolbarTextarea({
  className,
  onChange,
  value,
  ...props
}: React.ComponentProps<typeof Textarea>) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const maxHeight = 160;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  return (
    <div className="col-start-2 row-start-1 grid min-w-0 w-full flex-1">
      <Textarea
        id="toolbar-input"
        placeholder="Type your message..."
        className={cn(
          "h-fit min-h-10 px-1 @md/chat:text-base",
          "resize-none overflow-y-auto border-none shadow-none placeholder:whitespace-nowrap focus-visible:border-none focus-visible:ring-0",
          "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 hover:[&::-webkit-scrollbar-thumb]:bg-white/25",
          className,
        )}
        rows={1}
        onChange={(event) => {
          onChange?.(event);
          setTimeout(() => adjustHeight(), 0);
        }}
        ref={textareaRef}
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,0.25) transparent",
        }}
        value={value}
        {...props}
      />
    </div>
  );
}

export function ChatToolbarUnderInput({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-1 col-span-3 row-start-2 mt-1 flex min-h-7 items-center gap-2",
        className,
      )}
      {...props}
    >
      {children}
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
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
