'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AgentBadge, type AgentName } from './agent-badge'
import { Check } from 'lucide-react'
import type { DecisionItem } from './decision-card'

const STAGES: AgentName[] = [
  'crawler',
  'analyst',
  'competitor',
  'writer',
  'critic',
  'scheduler'
]

export function AgentProgress({
  jobId,
  initialItems,
  isTerminal,
  status
}: {
  jobId: string
  initialItems: DecisionItem[]
  isTerminal: boolean
  status: string | null
}) {
  const [items, setItems] = useState<DecisionItem[]>(initialItems)
  const router = useRouter()
  const seenIds = useRef(new Set(initialItems.map((i) => i.id)))

  useEffect(() => {
    if (isTerminal) return
    const es = new EventSource(`/api/launch/${jobId}/events`)

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as DecisionItem
        if (!evt.id || seenIds.current.has(evt.id)) return
        seenIds.current.add(evt.id)
        setItems((prev) => [...prev, evt])

        if (
          evt.agent === 'orchestrator' &&
          (evt.step === 'pipeline_complete' || evt.step === 'pipeline_error')
        ) {
          es.close()
        }
      } catch {
        // ignore
      }
    }

    return () => es.close()
  }, [jobId, isTerminal])

  let currentStageIndex = -1
  if (status === 'completed') {
    currentStageIndex = STAGES.length
  } else {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (!item) continue
      const idx = STAGES.indexOf(item.agent)
      if (idx !== -1) {
        currentStageIndex = idx
        break
      }
    }
  }

  const trackWidth = Math.max(0, Math.min(100, (currentStageIndex / (STAGES.length - 1)) * 100)) || 0

  return (
    <div className="rounded-xl border bg-card px-4 py-8 shadow-sm">
      <div className="relative mx-auto flex w-full max-w-4xl items-center justify-between">
        <div className="absolute left-0 top-1/2 -mt-[1px] h-[2px] w-full bg-muted/50" />
        
        <div 
          className="absolute left-0 top-1/2 -mt-[1px] h-[2px] bg-primary transition-all duration-700 ease-in-out"
          style={{ width: `${trackWidth}%` }}
        />

        {STAGES.map((agent, index) => {
          const isCompleted = index < currentStageIndex || status === 'completed'
          const isActive = index === currentStageIndex && status !== 'completed' && status !== 'failed'
          const isPending = index > currentStageIndex

          return (
            <div key={agent} className="relative z-10 flex flex-col items-center gap-2 bg-card px-1 sm:px-2">
              <div 
                className={`flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all duration-500
                  ${isCompleted ? 'border-primary bg-primary text-primary-foreground' : 'border-muted bg-background text-muted-foreground'}
                  ${isActive ? 'border-primary bg-background ring-4 ring-primary/20 scale-110 shadow-sm text-primary' : ''}
                `}
              >
                {isCompleted ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span className="text-xs font-bold">{index + 1}</span>
                )}
              </div>
              <div className="absolute top-10">
                <AgentBadge 
                  agent={agent} 
                  className={`border-none shadow-none bg-transparent whitespace-nowrap transition-all duration-300
                    ${isActive ? 'opacity-100 font-bold scale-105' : 'opacity-50'}
                    ${isPending ? 'grayscale filter' : ''}
                  `} 
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

