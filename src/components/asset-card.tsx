'use client'

import { useState } from 'react'
import { ExternalLink, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHANNEL_META } from '@/lib/channels'
import { AgentBadge } from './agent-badge'
import { AssetContent } from './asset-content'
import type { Channel, ChannelContent } from '@/lib/agents/types'

export interface AssetVersion {
  id: string
  version: 'a' | 'b' | 'c' | string
  styleLabel?: string | null
  content: ChannelContent
  isRecommended: boolean
  criticScore?: string | number | null
  criticReasoning?: string | null
}

export function AssetCard({
  channel,
  versions,
}: {
  channel: Channel
  versions: AssetVersion[]
}) {
  const meta = CHANNEL_META[channel]
  const recommended = versions.find((v) => v.isRecommended) ?? versions[0]
  const [activeId, setActiveId] = useState(recommended?.id)
  const active = versions.find((v) => v.id === activeId) ?? recommended

  if (!active) return null

  const publishUrl = meta.publishUrl?.(active.content) ?? null

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/20 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{meta.label}</span>
            <span className="text-xs text-muted-foreground">{meta.shortLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground">{meta.publishHint}</p>
        </div>

        {publishUrl && (
          <a
            href={publishUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-secondary"
          >
            <ExternalLink className="h-3 w-3" />
            Open publish page
          </a>
        )}
      </div>

      {/* Version tabs */}
      <div className="flex items-center gap-1 border-b bg-muted/10 px-2 py-1.5">
        {versions.map((v) => {
          const isActive = v.id === active.id
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => setActiveId(v.id)}
              className={cn(
                'group inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
                isActive
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.isRecommended && (
                <Star
                  className={cn(
                    'h-3 w-3',
                    isActive ? 'fill-amber-400 text-amber-500' : 'text-amber-500',
                  )}
                />
              )}
              <span className="font-mono uppercase">{v.version}</span>
              {v.styleLabel && (
                <span className="text-muted-foreground">{v.styleLabel}</span>
              )}
              {v.criticScore != null && (
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {Number(v.criticScore).toFixed(0)}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Critic reasoning if this version is the recommendation */}
      {active.isRecommended && active.criticReasoning && (
        <div className="border-b bg-amber-50/50 px-4 py-3 text-xs dark:bg-amber-950/20">
          <div className="mb-1 flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300">
            <AgentBadge agent="critic" />
            <span>Why this version</span>
          </div>
          <p className="leading-relaxed text-muted-foreground">{active.criticReasoning}</p>
        </div>
      )}

      <div className="px-4 py-4">
        <AssetContent content={active.content} />
      </div>
    </div>
  )
}
