import { Handle, Position, type NodeProps, useStore } from "reactflow";
import type { InsightNodeData } from "../../types/flow";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { ScrollArea } from "@/components/ui/scroll-area";

type InsightNodeProps = NodeProps<InsightNodeData>;

export default function InsightNode({ data, selected }: InsightNodeProps) {
  const zoom = useStore((state) => state.transform[2]);
  const isMicro = zoom <= 0.55;
  const isCompact = !isMicro && zoom <= 0.85;

  if (isMicro) {
    return (
      <Card
        className={`relative w-[220px] border-border/70 bg-card/90 text-foreground shadow-xl shadow-black/25 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
          selected ? "ring-1 ring-primary/40 after:opacity-100" : ""
        }`}
      >
        <CardContent className="flex items-center justify-center px-4 py-5">
          <div className="text-center text-xl font-semibold tracking-wide text-foreground">
            {data.titleTiny || data.titleShort || data.titleLong || "Node"}
          </div>
        </CardContent>
        <Handle type="source" position={Position.Right} />
        <Handle type="target" position={Position.Left} />
      </Card>
    );
  }

  if (isCompact) {
    return (
      <Card
        className={`relative w-[280px] border-border/70 bg-card/90 text-foreground shadow-xl shadow-black/25 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
          selected ? "ring-1 ring-primary/40 after:opacity-100" : ""
        }`}
      >
        <CardContent className="p-4">
          <div className="text-lg font-semibold text-foreground">
            {data.titleShort || data.titleLong}
          </div>
        </CardContent>
        <Handle type="source" position={Position.Right} />
        <Handle type="target" position={Position.Left} />
      </Card>
    );
  }

  return (
    <Card
      className={`node-card relative w-[340px] border-border/70 bg-card/90 text-foreground shadow-xl shadow-black/25 transition-[box-shadow,transform] duration-200 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? "ring-1 ring-primary/40 after:opacity-100" : ""
      }`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-[0.25em] text-muted-foreground">
          <span>Insight</span>
          <Badge
            variant="secondary"
            className="border border-border/70 bg-background/70 text-[0.65rem] font-semibold tracking-wide text-muted-foreground"
          >
            {data.titleTiny || "Node"}
          </Badge>
        </div>
        <div className="mt-2 text-sm font-semibold text-foreground">
          {data.titleLong || data.titleShort}
        </div>
        <div className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Excerpt
        </div>
        <div className="nodrag nopan" onWheelCapture={(event) => event.stopPropagation()}>
          <ScrollArea className="node-excerpt-scroll mt-2 h-[110px]">
            <MarkdownRenderer
              source={data.excerpt}
              className="node-excerpt text-xs leading-relaxed text-foreground/80"
            />
          </ScrollArea>
        </div>
      </CardContent>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </Card>
  );
}
