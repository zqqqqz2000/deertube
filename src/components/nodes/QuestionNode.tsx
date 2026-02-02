import { Handle, Position } from 'reactflow'
import type { QuestionNodeData } from '../../types/flow'

type QuestionNodeProps = {
  data: QuestionNodeData
}

export default function QuestionNode({ data }: QuestionNodeProps) {
  return (
    <div className="w-[360px] rounded-2xl border border-white/10 bg-slate-950/90 p-4 text-white shadow-xl shadow-black/40">
      <div className="text-[0.65rem] uppercase tracking-[0.25em] text-white/50">Question</div>
      <div className="mt-2 text-sm font-semibold text-white">{data.question}</div>
      <div className="mt-3 text-[0.65rem] uppercase tracking-[0.2em] text-white/40">Answer</div>
      <div className="mt-2 text-xs leading-relaxed text-white/80">{data.answer}</div>
      {data.status && <div className="mt-3 text-[0.7rem] text-amber-300">{data.status}</div>}
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </div>
  )
}
