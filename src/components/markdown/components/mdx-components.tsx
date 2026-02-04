import type { HTMLAttributes } from "react";
import type { Components } from "react-markdown";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Pre } from "@/components/markdown/components/pre";

export const mdxComponents: Components = {
  a: (props: HTMLAttributes<HTMLAnchorElement>) => (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-300 underline-offset-4 hover:underline"
      {...props}
    />
  ),
  pre: (props: HTMLAttributes<HTMLPreElement>) => <Pre {...props} />,
  ol: (props: HTMLAttributes<HTMLOListElement>) => (
    <ol style={{ listStyle: "revert" }} {...props} />
  ),
  ul: (props: HTMLAttributes<HTMLUListElement>) => (
    <ul style={{ listStyle: "revert" }} {...props} />
  ),
  table: (props: HTMLAttributes<HTMLTableElement>) => (
    <ScrollArea>
      <table {...props} />
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};
