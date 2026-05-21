'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DecisionCard, type DecisionItem } from './decision-card'

/**
 * Live decision timeline.
 *
 * - Hydrates from server-rendered `initial` (the snapshot at page load).
 * - Opens an EventSource to /api/launch/[id]/events for live updates.
 * - Dedupes events by id.
 *
 * Why EventSource (not WebSocket): one-way server → client, simpler,
 * works through corporate proxies, auto-reconnects.
 */
export function TimelineLive({
  jobId,
  initial,
  isTerminal,
}: {
  jobId: string
  initial: DecisionItem[]
  isTerminal: boolean
}) {
  const [items, setItems] = useState<DecisionItem[]>(initial)
  const [connected, setConnected] = useState(false)
  const seenIds = useRef(new Set(initial.map((i) => i.id)))
  const router = useRouter()

  useEffect(() => {
    if (isTerminal) return
    const es = new EventSource(`/api/launch/${jobId}/events`)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as DecisionItem
        if (!evt.id || seenIds.current.has(evt.id)) return
        seenIds.current.add(evt.id)
        setItems((prev) => [...prev, evt])

        // Pipeline-complete or pipeline-error: close stream.
        if (
          evt.agent === 'orchestrator' &&
          (evt.step === 'pipeline_complete' || evt.step === 'pipeline_error')
        ) {
          es.close()
          setTimeout(() => router.refresh(), 800)
        }
      } catch {
        // ignore malformed events
      }
    }

    return () => {
      es.close()
    }
  }, [jobId, isTerminal, router])

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
        <span className="inline-block h-2 w-2 animate-pulse-soft rounded-full bg-primary" />
        Waiting for the worker to pick up this job...
        <span className="text-xs">Make sure <code className="rounded bg-muted px-1">pnpm dev:worker</code> is running.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <DecisionCard key={item.id} item={item} isLatest={!isTerminal && i === items.length - 1} />
      ))}
      {!isTerminal && (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse-soft' : 'bg-zinc-400'}`} />
          {connected ? 'Live — listening for next decision' : 'Reconnecting...'}
        </div>
      )}
    </div>
  )
}
