import { Handle, Position, type NodeProps } from 'reactflow'
import type { QuestionNodeData } from '../../types/flow'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

type QuestionNodeProps = NodeProps<QuestionNodeData>

export default function QuestionNode({ data, selected }: QuestionNodeProps) {
  return (
    <Card
      className={`relative w-[360px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40 transition-[box-shadow,transform] duration-200 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(251,191,36,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? "ring-1 ring-white/20 after:opacity-100" : ""
      }`}
    >
      <CardContent className="p-4">
        <div className="text-[0.65rem] uppercase tracking-[0.25em] text-white/50">Question</div>
        <div className="mt-2 text-sm font-semibold text-white">{data.question}</div>
        <div className="mt-3 text-[0.65rem] uppercase tracking-[0.2em] text-white/40">Answer</div>
        <div className="mt-2 text-xs leading-relaxed text-white/80">{data.answer}</div>
        {data.status && (
          <Badge variant="secondary" className="mt-3 border border-amber-400/30 bg-amber-500/10 text-amber-200">
            {data.status}
          </Badge>
        )}
      </CardContent>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </Card>
  )
}
