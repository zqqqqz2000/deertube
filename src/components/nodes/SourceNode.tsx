import { Handle, Position, type NodeProps } from 'reactflow'
import type { SourceNodeData } from '../../types/flow'
import { Card, CardContent } from '@/components/ui/card'

type SourceNodeProps = NodeProps<SourceNodeData>

export default function SourceNode({ data, selected }: SourceNodeProps) {
  return (
    <Card
      className={`relative w-[300px] border-white/10 bg-slate-900/90 text-white shadow-xl shadow-black/40 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(56,189,248,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? "ring-1 ring-white/20 after:opacity-100" : ""
      }`}
    >
      <CardContent className="p-4">
        <div className="text-[0.65rem] uppercase tracking-[0.25em] text-white/50">Source</div>
        <div className="mt-2 text-sm font-semibold">{data.title}</div>
        <div className="mt-1 break-all text-[0.7rem] text-white/50">{data.url}</div>
        {data.snippet && (
          <div className="mt-3 max-h-24 overflow-hidden text-[0.75rem] leading-relaxed text-white/70">
            {data.snippet}
          </div>
        )}
      </CardContent>
      <Handle type="target" position={Position.Left} />
    </Card>
  )
}
