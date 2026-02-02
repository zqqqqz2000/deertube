import { Handle, Position, type NodeProps } from 'reactflow'
import type { QuestionNodeData } from '../../types/flow'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RotateCw } from 'lucide-react'
import { useQuestionActionContext } from '../flow/QuestionActionContext'

type QuestionNodeProps = NodeProps<QuestionNodeData>

export default function QuestionNode({ id, data, selected }: QuestionNodeProps) {
  const actions = useQuestionActionContext()
  const isRunning = data.status === 'running'
  const isFailed = data.status === 'failed'

  return (
    <Card
      className={`relative w-[360px] border-white/10 bg-slate-950/90 text-white shadow-xl shadow-black/40 transition-[box-shadow,transform] duration-200 before:pointer-events-none before:absolute before:-inset-1 before:rounded-[18px] before:opacity-0 before:transition-opacity before:duration-200 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(251,191,36,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? 'ring-1 ring-white/20 after:opacity-100' : ''
      } ${isFailed ? 'before:opacity-100 before:shadow-[0_0_16px_rgba(248,113,113,0.4)]' : ''} ${
        isRunning
          ? 'before:opacity-100 before:shadow-[0_0_18px_rgba(52,211,153,0.45)] before:animate-[halo-breathe_3.8s_ease-in-out_infinite]'
          : ''
      }`}
    >
      <CardContent className="p-4">
        <div className="text-[0.65rem] uppercase tracking-[0.25em] text-white/50">Question</div>
        <div className="mt-2 text-sm font-semibold text-white">{data.question}</div>
        <div className="mt-3 flex items-center justify-between">
          <div className="text-[0.65rem] uppercase tracking-[0.2em] text-white/40">Answer</div>
          {isFailed && actions && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/60 hover:text-white"
              onClick={() => actions.retryQuestion(id)}
              aria-label="Retry request"
              title="Retry request"
              disabled={actions.busy}
            >
              <RotateCw />
            </Button>
          )}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-white/80">{data.answer}</div>
        {data.status && (
          <Badge
            variant="secondary"
            className={`mt-3 ${
              isRunning
                ? 'border border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                : 'border border-rose-400/30 bg-rose-500/10 text-rose-200'
            }`}
          >
            {isRunning ? 'Running' : 'Failed'}
          </Badge>
        )}
      </CardContent>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </Card>
  )
}
