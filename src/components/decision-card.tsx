'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock, Coins } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentBadge, type AgentName } from './agent-badge'

export interface DecisionItem {
  id: string
  agent: AgentName
  step: string
  inputSummary?: string | null
  outputSummary?: string | null
  reasoning?: string | null
  model?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | string | null
  durationMs?: number | null
  status?: 'ok' | 'error' | 'skipped' | string | null
  error?: string | null
  createdAt: string
}

export function DecisionCard({
  item,
  isLatest,
}: {
  item: DecisionItem
  isLatest?: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasDetails =
    !!item.reasoning ||
    !!item.error ||
    item.tokensIn != null ||
    item.costUsd != null

  const isError = item.status === 'error'

  return (
    <div
      className={cn(
        'group relative rounded-2xl border bg-card px-4 py-4 shadow-sm transition-all duration-300 ease-in-out',
        isError ? 'border-destructive/50 bg-destructive/5' : 'hover:shadow-md',
        isLatest && !isError && 'border-primary/50 shadow-md ring-2 ring-primary/10',
      )}
    >
      <div className="flex items-start gap-4">
        {/* Left Avatar / Badge Area */}
        <div className="flex flex-col items-center gap-2 mt-1">
          <div className={cn(
            "relative flex shrink-0 items-center justify-center rounded-full bg-background p-1 shadow-sm border",
            isLatest && !isError ? "border-primary text-primary animate-pulse-soft" : "border-muted"
          )}>
             <AgentBadge agent={item.agent} className="border-none shadow-none bg-transparent px-1 py-0.5" />
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">{item.step}</span>
              {isError && (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold text-destructive">FAILED</span>
              )}
            </div>
            
            <div className="flex items-center gap-3 text-xs text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity">
              {item.durationMs != null && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatDuration(item.durationMs)}
                </span>
              )}
              {item.costUsd != null && Number(item.costUsd) > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Coins className="h-3 w-3" />${formatCost(item.costUsd)}
                </span>
              )}
            </div>
          </div>

          <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90">
            {item.outputSummary && (
              <p className="leading-relaxed">{item.outputSummary}</p>
            )}
            {!item.outputSummary && item.inputSummary && (
              <p className="leading-relaxed text-muted-foreground">{item.inputSummary}</p>
            )}
          </div>

          {hasDetails && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {open ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {open ? 'Hide details' : 'View internal thoughts'}
              </button>

              {open && (
                <div className="mt-3 animate-in slide-in-from-top-1 fade-in-50 space-y-3 rounded-lg border bg-muted/30 p-3 text-xs font-mono text-muted-foreground">
                  {item.reasoning && (
                    <div>
                      <div className="mb-1 uppercase text-[10px] font-bold tracking-wider text-foreground/50">Thought Process</div>
                      <div className="whitespace-pre-wrap leading-relaxed">{item.reasoning}</div>
                    </div>
                  )}
                  {item.error && (
                    <div>
                      <div className="mb-1 uppercase text-[10px] font-bold tracking-wider text-destructive/80">Error</div>
                      <div className="whitespace-pre-wrap leading-relaxed text-destructive">{item.error}</div>
                    </div>
                  )}
                  {(item.tokensIn != null || item.tokensOut != null) && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[10px]">
                      {item.model && <span>model: <span className="font-semibold text-foreground/70">{item.model}</span></span>}
                      {item.tokensIn != null && (
                        <span>
                          tokens: <span className="font-semibold text-foreground/70">{item.tokensIn}</span> {'->'} <span className="font-semibold text-foreground/70">{item.tokensOut ?? 0}</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function formatCost(cost: number | string): string {
  const n = typeof cost === 'string' ? parseFloat(cost) : cost
  if (n < 0.01) return n.toFixed(4)
  return n.toFixed(3)
}
