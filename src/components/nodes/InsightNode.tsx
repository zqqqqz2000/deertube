import { Handle, Position, type NodeProps, useStore } from "reactflow";
import type { InsightNodeData } from "../../types/flow";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type InsightNodeProps = NodeProps<InsightNodeData>;

export default function InsightNode({ data, selected }: InsightNodeProps) {
  const zoom = useStore((state) => state.transform[2]);
  const isMicro = zoom <= 0.55;
  const isCompact = !isMicro && zoom <= 0.85;

  if (isMicro) {
    return (
      <Card
        className={`relative w-[220px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
          selected ? "ring-1 ring-white/20 after:opacity-100" : ""
        }`}
      >
        <CardContent className="flex items-center justify-center px-4 py-5">
          <div className="text-center text-xl font-semibold tracking-wide text-white/95">
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
        className={`relative w-[280px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
          selected ? "ring-1 ring-white/20 after:opacity-100" : ""
        }`}
      >
        <CardContent className="p-4">
          <div className="text-lg font-semibold text-white">
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
      className={`relative w-[340px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40 transition-[box-shadow,transform] duration-200 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(59,130,246,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? "ring-1 ring-white/20 after:opacity-100" : ""
      }`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-[0.25em] text-white/50">
          <span>Insight</span>
          <Badge
            variant="secondary"
            className="border border-white/10 bg-white/5 text-[0.65rem] font-semibold tracking-wide text-white/70"
          >
            {data.titleTiny || "Node"}
          </Badge>
        </div>
        <div className="mt-2 text-sm font-semibold text-white">
          {data.titleLong || data.titleShort}
        </div>
        <div className="mt-3 text-xs uppercase tracking-[0.2em] text-white/40">
          Excerpt
        </div>
        <div className="mt-2 text-xs leading-relaxed text-white/80">
          {data.excerpt}
        </div>
      </CardContent>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </Card>
  );
}
