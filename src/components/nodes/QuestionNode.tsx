import { Handle, Position } from 'reactflow'
import type { QuestionNodeData } from '../../types/flow'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

type QuestionNodeProps = {
  data: QuestionNodeData
}

export default function QuestionNode({ data }: QuestionNodeProps) {
  return (
    <Card className="w-[360px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40">
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
