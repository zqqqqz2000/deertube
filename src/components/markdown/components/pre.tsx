import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface PreProps extends HTMLAttributes<HTMLPreElement> {
  "data-language"?: string;
}

export function Pre({ className, children, ...props }: PreProps) {
  const language = props["data-language"];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
      {language ? (
        <div className="flex h-9 items-center justify-between border-b border-border bg-muted/60 px-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <span>{language}</span>
        </div>
      ) : null}
      <ScrollArea>
        <pre
          className={cn("m-0 p-3 text-sm leading-relaxed", className)}
          {...props}
        >
          {children}
        </pre>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
