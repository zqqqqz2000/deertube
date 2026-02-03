import { cn } from "@/lib/utils";

export function Chat({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex h-full flex-col overflow-hidden @container/chat", className)}
      {...props}
    >
      {children}
    </div>
  );
}
